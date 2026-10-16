/**
 * Client half of the dsh-skill-managers bundle (TypeScript source).
 *
 * A DSH client module is a plain script registering a lazy factory whose `id` equals the
 * package name; the factory returns a Cordis plugin. `build.mjs` wraps this module in that
 * handshake, so the file itself is an ordinary CommonJS module: React arrives through
 * `require`, and the factory's return value is `module.exports`.
 *
 * No JSX: the element tree is built with `React.createElement`, which keeps the bundle free
 * of a `react/jsx-runtime` import the browser module table may not expose.
 *
 * Presentation is by **category**, not by session. `skills/list` is session-addressed, but
 * that address is only transport plumbing — the host half registers the filesystem roots
 * globally, so every session returns the same complete catalog. The page therefore asks
 * one retained session for the data and shows All / Global / Workspaces.
 */

const React = require('react') as typeof import('react');
const h = React.createElement;
const { useState, useEffect, useMemo, useRef } = React;

// ------------------------------------------------------------------------- Types

interface SkillSummary {
  name: string;
  description: string;
  modelInvocable?: boolean;
  whenToUse?: string;
  path?: string;
}

interface Deps {
  sessions: unknown;
  skills: unknown;
  workspaces: unknown;
}

type CategoryId = 'all' | 'global' | 'workspaces';
type OriginKind = 'workspace' | 'global' | 'bundled' | 'other';

interface Origin {
  kind: OriginKind;
  workspacePath?: string;
  workspaceTitle?: string;
}

interface Decorated {
  skill: SkillSummary;
  origin: Origin;
}

interface Section {
  key: string;
  label: string;
  hint: string;
  items: Decorated[];
}

// ------------------------------------------------------------------------- Constants

const PLUGIN_ID = 'dsh-skill-managers';
const PANEL_ID = 'skills';
const NS = 'skillsManager';
const PANEL_ORDER = 5;

const CATEGORIES: Array<{ id: CategoryId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'global', label: 'Global' },
  { id: 'workspaces', label: 'Workspaces' },
];

const ROOTS = [
  { rank: 100, label: 'Project (DSH)', path: '<workspace>/.dsh/skills' },
  { rank: 200, label: 'Project (agents)', path: '<workspace>/.agents/skills' },
  { rank: 300, label: 'Custom', path: 'Config.customSkillDirs' },
  { rank: 400, label: 'Global (all sessions)', path: '~/.dsh/skills' },
  { rank: 500, label: 'Global (shared)', path: '~/.agents/skills' },
  { rank: 600, label: 'Bundled', path: 'shipped with DSH' },
];

const ORIGIN_LABEL: Record<OriginKind, string> = {
  workspace: 'workspace',
  global: 'global',
  bundled: 'bundled',
  other: 'other',
};

const ORIGIN_COLOR: Record<OriginKind, string> = {
  workspace: '#38a169',
  global: '#3182ce',
  bundled: '#805ad5',
  other: '#dd6b20',
};

const CSS = [
  '.skm-page{height:100%;overflow:auto;box-sizing:border-box;padding:28px 32px 40px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
  '.skm-inner{max-width:900px;margin:0 auto}',
  '.skm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:6px}',
  '.skm-title{font-size:18px;font-weight:600;margin:0}',
  '.skm-sub{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}',
  '.skm-tools{display:flex;align-items:center;gap:8px}',
  '.skm-input{box-sizing:border-box;width:200px;padding:5px 10px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-primary,transparent);color:inherit;font:inherit;font-size:12px}',
  '.skm-input:focus{outline:none;border-color:var(--dsw-alias-border-l3)}',
  '.skm-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:5px 10px;white-space:nowrap}',
  '.skm-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.skm-btn:disabled{opacity:.5;cursor:default}',
  '.skm-tabs{display:flex;gap:4px;margin:16px 0 0;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:0}',
  '.skm-tab{border:none;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;font-weight:500;cursor:pointer;padding:6px 12px;border-bottom:2px solid transparent;margin-bottom:-1px}',
  '.skm-tab:hover{color:var(--dsw-alias-label-secondary)}',
  '.skm-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-ongoing-primary,#3182ce)}',
  '.skm-tabcount{margin-left:6px;color:var(--dsw-alias-label-quaternary);font-size:10px}',
  '.skm-groups{display:flex;flex-direction:column;gap:22px;margin-top:18px}',
  '.skm-grouphead{display:flex;align-items:baseline;gap:8px;margin-bottom:8px;flex-wrap:wrap}',
  '.skm-grouptitle{margin:0;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-tertiary)}',
  '.skm-groupcount{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 7px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-quaternary)}',
  '.skm-grouphint{font-size:11px;color:var(--dsw-alias-label-quaternary)}',
  '.skm-list{display:flex;flex-direction:column;gap:8px}',
  '.skm-row{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);padding:12px 14px;background:var(--dsw-alias-bg-primary,transparent)}',
  '.skm-rowhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
  '.skm-srcbadge{display:inline-flex;align-items:center;font-size:9px;font-weight:500;text-transform:uppercase;letter-spacing:.03em;padding:0 6px;line-height:16px;border-radius:3px}',
  '.skm-name{cursor:pointer;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);transition:color .15s;background:none;border:none;padding:0}',
  '.skm-name:hover{color:var(--dsw-alias-state-ongoing-primary,#3182ce)}',
  '.skm-name.copied-flash{color:var(--dsw-alias-state-success-primary,#38a169)}',
  '.skm-badge{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
  '.skm-badge[data-tone="user"]{border-color:var(--dsw-alias-state-ongoing-primary,#3182ce);color:var(--dsw-alias-state-ongoing-primary,#3182ce)}',
  '.skm-spacer{flex:1 1 auto}',
  '.skm-desc{margin:6px 0 0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
  '.skm-when{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;overflow-wrap:anywhere}',
  '.skm-pathtoggle{display:inline-block;background:none;border:none;cursor:pointer;color:var(--dsw-alias-label-quaternary);font-size:11px;padding:2px 6px;border-radius:4px}',
  '.skm-pathtoggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}',
  '.skm-path{margin:6px 0 0;color:var(--dsw-alias-label-quaternary);font-size:11px;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);overflow-wrap:anywhere}',
  '.skm-empty{margin-top:24px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);padding:20px;color:var(--dsw-alias-label-tertiary);text-align:center}',
  '.skm-empty b{display:block;color:var(--dsw-alias-label-secondary);font-weight:600;margin-bottom:4px}',
  '.skm-error{margin-top:18px;border:1px solid var(--dsw-alias-state-error-primary,#c53030);border-radius:var(--dsw-radius-lg,10px);padding:12px 14px;color:var(--dsw-alias-state-error-primary,#c53030);font-size:12px;overflow-wrap:anywhere}',
  '.skm-foot{margin-top:28px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2)}',
  '.skm-foot summary{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-quaternary);font-weight:600;margin:0 0 8px;cursor:pointer}',
  '.skm-foot summary:hover{color:var(--dsw-alias-label-tertiary)}',
  '.skm-roots{width:100%;border-collapse:collapse;font-size:12px}',
  '.skm-roots td{padding:3px 0;vertical-align:top}',
  '.skm-roots td:first-child{color:var(--dsw-alias-label-quaternary);width:26px}',
  '.skm-roots td:nth-child(2){color:var(--dsw-alias-label-secondary);padding-right:14px;white-space:nowrap}',
  '.skm-roots td:last-child{color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}',
  '.skm-hint{margin:12px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px}',
  '.skm-kbd{border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 5px;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px}',
].join('');

if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + NS + '"]')) {
  const style = document.createElement('style');
  style.dataset.plugin = PLUGIN_ID;
  style.dataset.pluginCss = NS;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ------------------------------------------------------------------------- Helpers

function normalizePath(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\\/g, '/').replace(/\/+$/, '') : '';
}

/**
 * The session used to reach the catalog.
 *
 * This is transport, not scope: the host half registers every filesystem root globally,
 * so any retained session returns the same complete set. Prefer one the main view
 * retains, else the most recently updated ordinary session.
 */
function resolveSession(list: unknown): Record<string, unknown> | undefined {
  const byId = (list as Record<string, unknown>)?.byId as Record<string, Record<string, unknown>> | undefined;
  if (!byId) return undefined;
  const rows = Object.values(byId).filter((row): row is Record<string, unknown> =>
    row != null && typeof row.id === 'string'
  );
  const main = rows.find((row) => {
    const retainedBy = row.retainedBy as Record<string, number> | undefined;
    return retainedBy != null && (retainedBy.mainView || 0) > 0;
  });
  if (main) return main;
  const ordinary = rows.filter((row) => row.origin !== 'subagent' && row.blank !== true);
  ordinary.sort((a, b) => ((b.updatedAt as number) || 0) - ((a.updatedAt as number) || 0));
  return ordinary.length > 0 ? ordinary[0] : undefined;
}

/** Workspaces DSH knows about: `{ path, title }`, in registry order. */
function workspaceList(snapshot: unknown): Array<{ path: string; title: string }> {
  const items = Array.isArray((snapshot as { items?: unknown })?.items)
    ? ((snapshot as { items: unknown[] }).items)
    : [];
  const out: Array<{ path: string; title: string }> = [];
  for (const item of items) {
    const row = item as { path?: unknown; title?: unknown };
    const path = normalizePath(row?.path);
    if (path === '') continue;
    out.push({ path, title: typeof row?.title === 'string' && row.title !== '' ? row.title : path });
  }
  return out;
}



/**
 * Attribute one skill by its instruction-file path.
 *
 * Project roots nest inside `~/.dsh/skills`-shaped paths, so workspace membership is
 * checked first. `skills/list` strips `source`/`provider`, so path is the only signal.
 */
function originOf(skill: SkillSummary, workspaces: Array<{ path: string; title: string }>): Origin {
  const path = normalizePath(skill.path);
  // A bundled skill provider (e.g. Office) supplies `resourceBase`, not `path`, and
  // `skills/list` strips both `source` and `provider` — so an empty path is the
  // clearest signal that this skill is shipped rather than rooted in a directory.
  if (path === '') return { kind: 'bundled' };
  for (const workspace of workspaces) {
    if (path.indexOf(workspace.path + '/') === 0) {
      return { kind: 'workspace', workspacePath: workspace.path, workspaceTitle: workspace.title };
    }
  }
  if (path.indexOf('/dsh-agent-preset/skills/') !== -1 || path.indexOf('/office-skills/') !== -1) {
    return { kind: 'bundled' };
  }
  if (path.indexOf('/.dsh/skills/') !== -1 || path.indexOf('/.agents/skills/') !== -1) return { kind: 'global' };
  return { kind: 'other' };
}

/** Read one session's user-invocable skill catalog. */
function loadCatalog(deps: Deps, sessionId: string, signal: AbortSignal): Promise<SkillSummary[]> {
  const sessions = deps.sessions as Record<string, unknown>;
  const skills = deps.skills as Record<string, unknown>;
  if (!skills) return Promise.reject(new Error('the skills Remote is not mounted'));
  if (!sessions) return Promise.reject(new Error('the sessions service is not mounted'));
  const binding = (sessions as Record<string, (id: string) => unknown>).binding?.(sessionId);
  if (!binding) return Promise.reject(new Error('no session is available to read the catalog'));
  const using = sessions as Record<string, (
    id: string,
    opts: Record<string, unknown>,
    cb: (ref: Record<string, unknown>) => unknown
  ) => unknown>;
  return using.using?.(sessionId, { source: 'skillsManager', signal }, function (reference) {
    signal.throwIfAborted();
    const binding = (reference as { binding?: { session?: { getSnapshot(): Record<string, unknown> } } }).binding;
    const state = binding?.session?.getSnapshot?.() as { openState?: string; openError?: Error } | undefined;
    if (state === undefined || state.openState !== 'open') {
      throw state?.openError ?? new Error('session not open');
    }
    const listFn = skills as { list?: (params: { sessionId: string }, sig: AbortSignal) => Promise<{ ok: boolean; value?: { skills: SkillSummary[] }; error?: { code: string; message: string } }> };
    return listFn.list?.({ sessionId }, signal).then(function (result) {
      if (!result.ok) {
        throw new Error('skills/list failed: ' + result.error?.code + ': ' + result.error?.message);
      }
      return result.value?.skills ?? [];
    });
  }) as Promise<SkillSummary[]>;
}

function clipboardCopy(text: string): boolean {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* silent */ }
  return false;
}

// ------------------------------------------------------------------------- Components

function SkillRow(props: {
  skill: SkillSummary;
  origin: Origin;
  /** True while this row's command is the one just copied. */
  copied: boolean;
  flashName: string | null;
  onCopy: (command: string) => void;
  onNameClick: (command: string) => void;
  pathOpen: boolean;
  onPathToggle: () => void;
}): React.ReactElement {
  const { skill, origin, copied, flashName, onCopy, onNameClick, pathOpen, onPathToggle } = props;
  const command = '/' + skill.name;
  const color = ORIGIN_COLOR[origin.kind];
  return h(
    'div',
    { className: 'skm-row' },
    h(
      'div',
      { className: 'skm-rowhead' },
      h(
        'span',
        {
          className: 'skm-srcbadge',
          style: { backgroundColor: color + '18', color, border: '1px solid ' + color + '40' },
          title: 'Source: ' + ORIGIN_LABEL[origin.kind] + (skill.path ? ' \u2014 ' + skill.path : ''),
        },
        ORIGIN_LABEL[origin.kind]
      ),
      h(
        'button',
        {
          type: 'button',
          className: 'skm-name' + (flashName === command ? ' copied-flash' : ''),
          onClick: () => onNameClick(command),
          title: 'Copy this command',
        },
        command
      ),
      skill.modelInvocable === false
        ? h('span', { className: 'skm-badge', 'data-tone': 'user', title: 'disable-model-invocation: visible only in the / menu' }, 'user only')
        : null,
      h('span', { className: 'skm-spacer' }),
      h('button', { type: 'button', className: 'skm-btn', onClick: () => onCopy(command) }, copied ? 'Copied' : 'Copy')
    ),
    h('p', { className: 'skm-desc' }, skill.description),
    skill.whenToUse ? h('p', { className: 'skm-when' }, 'When: ' + skill.whenToUse) : null,
    skill.path
      ? h(
          'div',
          null,
          h('button', { type: 'button', className: 'skm-pathtoggle', onClick: onPathToggle }, pathOpen ? '\u25BC\u00a0hide path' : '\u25B6\u00a0show path'),
          pathOpen ? h('p', { className: 'skm-path' }, skill.path) : null
        )
      : null
  );
}

function Roots(): React.ReactElement {
  return h(
    'details',
    { className: 'skm-foot' },
    h('summary', null, 'Where DSH looks for skills'),
    h(
      'table',
      { className: 'skm-roots' },
      h(
        'tbody',
        null,
        ROOTS.map((root) => h('tr', { key: root.rank }, h('td', null, root.rank), h('td', null, root.label), h('td', null, root.path)))
      )
    ),
    h(
      'p',
      { className: 'skm-hint' },
      'A skill is a directory with a ',
      h('code', { className: 'skm-kbd' }, 'SKILL.md'),
      ', one level deep. Type ',
      h('code', { className: 'skm-kbd' }, '/'),
      ' in the composer to run one, or copy the command from this list.'
    )
  );
}

function SkillsIcon(props: { size?: number }): React.ReactElement {
  const size = props?.size ?? 16;
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    h('path', { d: 'M3 2.5h7.5a1 1 0 0 1 1 1V11' }),
    h('path', { d: 'M5 4.8h4.5' }),
    h('path', { d: 'M5 7.3h3' }),
    h('path', { d: 'M3 2.5V11a2 2 0 0 0 2 2h6.5' }),
    h('path', { d: 'M13 11v3.5' })
  );
}

// ------------------------------------------------------------------------- Page

function SkillsPage(props: {
  useSessions: (cb: (snapshot: unknown) => unknown) => unknown;
  /** Composed by the slot owner, exactly like `useSessions` (a documented standard prop). */
  useWorkspaces?: (cb: (snapshot: unknown) => unknown) => unknown;
  skmDeps: Deps;
}): React.ReactElement {
  const { useSessions, useWorkspaces, skmDeps: deps } = props;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sessionsSnapshot = typeof useSessions === 'function' ? useSessions((snapshot: unknown) => snapshot) : undefined;
  const session = useMemo(() => resolveSession(sessionsSnapshot), [sessionsSnapshot]);
  const sessionId = (session as Record<string, string> | undefined)?.id;

  // Read workspaces from the composed hook, not from a service captured at apply()
  // time: the host hook is reactive, so a workspace added later appears without a reload.
  const workspacesSnapshot = typeof useWorkspaces === 'function' ? useWorkspaces((snapshot: unknown) => snapshot) : undefined;
  const workspaces = useMemo(() => workspaceList(workspacesSnapshot), [workspacesSnapshot]);

  const [state, setState] = useState<{ status: string; skills: SkillSummary[]; error: string | null }>({
    status: 'loading',
    skills: [],
    error: null,
  });
  const [category, setCategory] = useState<CategoryId>('all');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [flashName, setFlashName] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  useEffect(() => {
    if (sessionId === undefined) {
      setState({ status: 'no-session', skills: [], error: null });
      return;
    }
    const abort = new AbortController();
    let live = true;
    setState((prev) => ({ status: 'loading', skills: prev.skills, error: null }));
    loadCatalog(deps, sessionId, abort.signal).then(
      (skills) => { if (live) setState({ status: 'ready', skills, error: null }); },
      (error: Error) => { if (live) setState({ status: 'error', skills: [], error: String(error?.message ?? error) }); }
    );
    return () => { live = false; abort.abort(); };
  }, [sessionId, attempt]);

  useEffect(() => {
    if (copied === null) return;
    const handle = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(handle);
  }, [copied]);

  useEffect(() => {
    if (flashName === null) return;
    const handle = setTimeout(() => setFlashName(null), 800);
    return () => clearTimeout(handle);
  }, [flashName]);

  const copy = (command: string) => { if (clipboardCopy(command)) setCopied(command); };
  const onNameClick = (command: string) => {
    if (clipboardCopy(command)) { setFlashName(command); setCopied(command); }
  };
  const togglePath = (name: string) => setExpandedPaths((prev) => ({ ...prev, [name]: !prev[name] }));

  // Attribute every skill once, then filter and group.
  const decorated = useMemo(
    () => state.skills.map((skill) => ({ skill, origin: originOf(skill, workspaces) })),
    [state.skills, workspaces]
  );

  const visible = useMemo(() => {
    const needle = debouncedQuery.trim().toLowerCase();
    if (needle === '') return decorated;
    return decorated.filter(({ skill }) =>
      skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle)
    );
  }, [decorated, debouncedQuery]);

  const counts = useMemo(() => {
    let global = 0;
    let workspacesCount = 0;
    for (const item of decorated) {
      if (item.origin.kind === 'workspace') workspacesCount += 1;
      else global += 1;
    }
    return { all: decorated.length, global, workspaces: workspacesCount };
  }, [decorated]);

  const sections = useMemo<Section[]>(() => {
    const global: Decorated[] = [];
    const bundled: Decorated[] = [];
    const other: Decorated[] = [];
    const byWorkspace = new Map<string, { title: string; items: Decorated[] }>();
    for (const item of visible) {
      if (item.origin.kind === 'workspace') {
        const key = item.origin.workspacePath ?? '';
        const bucket = byWorkspace.get(key) ?? { title: item.origin.workspaceTitle ?? key, items: [] };
        bucket.items.push(item);
        byWorkspace.set(key, bucket);
      } else if (item.origin.kind === 'bundled') bundled.push(item);
      else if (item.origin.kind === 'other') other.push(item);
      else global.push(item);
    }
    const out: Section[] = [];
    if (category !== 'global') {
      // In the Workspaces category, list every registered workspace — including one with
      // no skills — because "which workspaces exist" is the question that tab answers.
      // In All, an empty section is noise, so only workspaces that contribute skills show.
      const seenPaths = new Set<string>();
      for (const workspace of workspaces) {
        const bucket = byWorkspace.get(workspace.path);
        seenPaths.add(workspace.path);
        if (bucket === undefined && category !== 'workspaces') continue;
        out.push({
          key: 'ws:' + workspace.path,
          label: 'Workspace \u00b7 ' + workspace.title,
          hint: workspace.path,
          items: bucket?.items ?? [],
        });
      }
      // A workspace the registry does not know about (e.g. a skill found under a root
      // outside the registry) still gets a section, so nothing is silently dropped.
      for (const [path, bucket] of byWorkspace) {
        if (seenPaths.has(path)) continue;
        out.push({ key: 'ws:' + path, label: 'Workspace \u00b7 ' + bucket.title, hint: path, items: bucket.items });
      }
    }
    if (category !== 'workspaces') {
      if (global.length > 0) out.push({ key: 'global', label: 'Global', hint: '~/.dsh/skills and ~/.agents/skills', items: global });
      if (bundled.length > 0) out.push({ key: 'bundled', label: 'Bundled', hint: 'shipped with DSH or registered by a plugin \u2014 this catalog wire carries no path', items: bundled });
      if (other.length > 0) out.push({ key: 'other', label: 'Other', hint: 'a custom root', items: other });
    }
    return out;
  }, [visible, category, workspaces]);

  const subtitle =
    state.status === 'ready'
      ? counts.all + (counts.all === 1 ? ' skill' : ' skills') +
        ' \u00b7 ' + counts.workspaces + ' in a workspace'
      : state.status === 'loading'
        ? 'Reading the catalog\u2026'
        : state.status === 'no-session'
          ? 'No session available to read the catalog'
          : 'Catalog unavailable';

  let body: React.ReactElement | null = null;
  if (state.status === 'error') {
    body = h('div', { className: 'skm-error' }, state.error);
  } else if (state.status === 'no-session') {
    body = h(
      'div',
      { className: 'skm-empty' },
      h('b', null, 'No session available'),
      'DSH needs one retained session as the transport for the catalog read. Open or start any session, then come back.'
    );
  } else if (state.status === 'ready' && counts.all === 0) {
    body = h(
      'div',
      { className: 'skm-empty' },
      h('b', null, 'No skills found'),
      'Nothing was found under the discovery roots below. Add a skill directory and refresh.'
    );
  } else if (visible.length === 0) {
    body = h('div', { className: 'skm-empty' }, h('b', null, 'No match'), 'Nothing matches \u201c' + query + '\u201d.');
  } else if (sections.length === 0) {
    body = h('div', { className: 'skm-empty' }, h('b', null, 'Nothing in this category'), 'Switch to another category to see skills.');
  } else {
    body = h(
      'div',
      { className: 'skm-groups' },
      sections.map((section) =>
        h(
          'section',
          { className: 'skm-group', key: section.key },
          h(
            'div',
            { className: 'skm-grouphead' },
            h('h2', { className: 'skm-grouptitle' }, section.label),
            h('span', { className: 'skm-groupcount' }, String(section.items.length)),
            h('span', { className: 'skm-grouphint' }, section.hint)
          ),
          h(
            'div',
            { className: 'skm-list' },
            section.items.map((item) =>
              h(SkillRow, {
                key: item.skill.name,
                skill: item.skill,
                origin: item.origin,
                copied: copied === '/' + item.skill.name,
                flashName,
                onCopy: copy,
                onNameClick,
                pathOpen: !!expandedPaths[item.skill.name],
                onPathToggle: () => togglePath(item.skill.name),
              })
            )
          )
        )
      )
    );
  }

  return h(
    'div',
    { className: 'skm-page' },
    h(
      'div',
      { className: 'skm-inner' },
      h(
        'div',
        { className: 'skm-head' },
        h('div', null, h('h1', { className: 'skm-title' }, 'Skills'), h('p', { className: 'skm-sub' }, subtitle)),
        h(
          'div',
          { className: 'skm-tools' },
          h('input', {
            className: 'skm-input',
            type: 'search',
            placeholder: 'Search skills',
            value: query,
            'aria-label': 'Search skills',
            onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'skm-btn',
              disabled: state.status === 'loading',
              onClick: () => setAttempt((v) => v + 1),
            },
            'Refresh'
          )
        )
      ),
      h(
        'div',
        { className: 'skm-tabs', role: 'tablist' },
        CATEGORIES.map((tab) =>
          h(
            'button',
            {
              key: tab.id,
              type: 'button',
              role: 'tab',
              className: 'skm-tab',
              'aria-selected': category === tab.id,
              onClick: () => setCategory(tab.id),
            },
            tab.label,
            h('span', { className: 'skm-tabcount' }, String(counts[tab.id]))
          )
        )
      ),
      body,
      Roots()
    )
  );
}

// ------------------------------------------------------------------------- Plugin registration

function apply(ctx: Record<string, unknown>): void {
  const ctxObj = ctx as Record<string, Record<string, unknown>>;
  // On the real client context, reading an **undeclared** service as a property throws
  // (`cannot get property "..."`). `workspaces` is not in this plugin's inject list, so
  // only `ctx.get` is safe for it — the same hazard the session-metrics strip documents.
  const getService = (ctx as Record<string, (name: string) => unknown>).get;
  const safeGet = (name: string): unknown => {
    try {
      return typeof getService === 'function' ? getService.call(ctx, name) : undefined;
    } catch {
      return undefined;
    }
  };
  const deps: Deps = {
    sessions: ctxObj.sessions,
    skills: ctxObj.remote?.skills ?? undefined,
    workspaces: safeGet('workspaces'),
  };

  const slots = ctxObj.slots as Record<string, (name: string, cb: () => unknown) => void>;
  const slRegister = ctxObj.slots as Record<string, (spec: Record<string, unknown>, component: unknown) => void>;

  slots.inject?.('main', () =>
    slRegister.register?.({ name: 'main', key: PANEL_ID, inject: () => ({ skmDeps: deps }) }, SkillsPage)
  );
  slots.inject?.('sidebar.panellist', () =>
    slRegister.register?.({ name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: () => 'Skills' }, SkillsIcon)
  );
}

module.exports = { name: PLUGIN_ID, inject: ['slots', 'sessions', 'remote', 'remote.skills'], apply };