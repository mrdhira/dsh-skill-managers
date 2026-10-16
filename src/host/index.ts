/**
 * Host half of the dsh-skill-managers bundle.
 *
 * The catalog the Web client reads (`skills/list`) is **session-addressed**, and DSH
 * deliberately keeps filesystem discovery out of the host layer:
 * `dsh-web-app/cordis.patch.yml` disables the base `skill-filesystem` row
 * ("presets own local discovery"). So `~/.dsh/skills` and `<project>/.dsh/skills`
 * exist only inside a *live* agent's preset scope; a cold session falls back to
 * `ctx.get('skills')` — the global layer — and loses every project and user root.
 * That is why the page could show only the 4 globally-registered skills.
 *
 * This half closes the gap without inventing a Remote. It registers one **global**
 * skill provider that scans the real roots itself; because `skill-catalog.js` falls
 * back to the global registry for any session, every session then sees the full set,
 * and the browser half is free to present categories instead of sessions.
 *
 * It scans filesystem roots only. Bundled skills keep arriving through the app's own
 * providers (e.g. `dsh-skill-office`), which already register globally.
 */

import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Loader identity for the bundle's host half. */
export const name = 'dsh-skill-managers';

/** Cordis service this half needs; without it the fiber waits. */
export const inject = ['skills'];

/** Identity of this provider; every candidate must echo it back. */
const PROVIDER = 'skills-manager-roots';

/** Kebab-case, the only name shape the registry accepts. */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Ranks mirror `@deepseek-ai/dsh-skill-filesystem`, so a duplicate resolves the same
 * way it does inside a preset: project before user.
 */
const RANK = {
  projectDsh: 100,
  projectAgents: 200,
  userDsh: 400,
  userAgents: 500,
} as const;

interface RootSpec {
  /** Absolute directory holding `<name>/SKILL.md` children. */
  readonly path: string;
  /** Wire source label, matching the filesystem provider's vocabulary. */
  readonly source: string;
  readonly rank: number;
  /** Set when the root belongs to a workspace, so the client can attribute it. */
  readonly workspacePath?: string;
}

interface Candidate {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean };
  readonly source: string;
  readonly provider: string;
  readonly rank: number;
  readonly path: string;
  readonly locator: { readonly file: string };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Read a boolean frontmatter field, tolerating the spellings the format allows. */
function booleanField(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'true' || raw === 'yes' || raw === 'on' || raw === '1') return true;
  if (raw === 'false' || raw === 'no' || raw === 'off' || raw === '0') return false;
  return undefined;
}

/**
 * Minimal frontmatter reader: top-level `key: value` plus `key: >` / `key: |` block
 * scalars. Deliberately not a YAML parser — skill frontmatter is a small flat shape
 * and the registry validates whatever this returns.
 */
function parseFrontmatter(text: string): Record<string, string> | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return undefined;
  const data: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[index]);
    if (kv === null) continue;
    const [, key, rawRest] = kv;
    if (rawRest === '>' || rawRest === '|') {
      const parts: string[] = [];
      while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) parts.push(lines[++index].trim());
      data[key] = parts.join(' ');
    } else {
      data[key] = rawRest.replace(/^["']|["']$/g, '');
    }
  }
  return data;
}

/** The instruction body, with the frontmatter block and the blank line after it removed. */
function bodyOf(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '').replace(/^\r?\n/, '');
}

/** Read one `SKILL.md` into a candidate, or `undefined` when it is not a valid skill. */
async function readSkill(file: string, spec: RootSpec, fallbackName: string): Promise<Candidate | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  const data = parseFrontmatter(text);
  if (data === undefined) return undefined;
  const name = data.name ?? fallbackName;
  const description = data.description ?? '';
  if (name === '' || description === '' || !SKILL_NAME.test(name)) return undefined;
  const modelInvocable = booleanField(data['disable-model-invocation']) !== true;
  const userInvocable = booleanField(data['user-invocable']) !== false;
  return {
    name,
    description,
    ...(data.whenToUse !== undefined && data.whenToUse !== '' ? { whenToUse: data.whenToUse } : {}),
    invocation: { modelInvocable, userInvocable },
    source: spec.source,
    provider: PROVIDER,
    rank: spec.rank,
    path: file,
    locator: { file },
    ...(spec.workspacePath !== undefined ? { metadata: { workspacePath: spec.workspacePath } } : {}),
  };
}

/** List one root's children; a missing or unreadable root is simply empty. */
async function listRoot(spec: RootSpec): Promise<Candidate[]> {
  let entries;
  try {
    entries = await readdir(spec.path, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: Candidate[] = [];
  for (const entry of entries) {
    // A dotted child (e.g. `~/.dsh/skills/.system`) is never a skill.
    if (entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const candidate = await readSkill(join(spec.path, entry.name, 'SKILL.md'), spec, entry.name);
    if (candidate !== undefined) found.push(candidate);
  }
  found.sort((left, right) => left.name.localeCompare(right.name));
  return found;
}

/** Every workspace DSH knows about, from the durable registry when it is mounted. */
function workspaceRoots(ctx: any): RootSpec[] {
  const list = ctx.get?.('workspaceRegistry')?.list?.();
  if (!Array.isArray(list)) return [];
  const roots: RootSpec[] = [];
  for (const workspace of list) {
    const path = typeof workspace?.path === 'string' ? workspace.path : undefined;
    if (path === undefined) continue;
    roots.push({ path: join(path, '.dsh/skills'), source: 'project-dsh', rank: RANK.projectDsh, workspacePath: path });
    roots.push({ path: join(path, '.agents/skills'), source: 'project-agents', rank: RANK.projectAgents, workspacePath: path });
  }
  return roots;
}

/**
 * Install the provider.
 *
 * @param ctx - Profile-scope context. Registration from an unscoped context lands in
 *   the **global layer**, which is exactly what a cold session's catalog read falls
 *   back to — that is the whole point of this half.
 */
export function apply(ctx: any): void {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const agentsHome = process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents');

  const roots = (): RootSpec[] => [
    ...workspaceRoots(ctx),
    { path: join(dshHome, 'skills'), source: 'user-dsh', rank: RANK.userDsh },
    { path: join(agentsHome, 'skills'), source: 'user-agents', rank: RANK.userAgents },
  ];

  ctx.inject(['skills'], (injected: any) => {
    injected.skills.registerProvider(() => ({
      name: PROVIDER,
      async list() {
        const groups = await Promise.all(roots().map((spec) => listRoot(spec)));
        return { candidates: groups.flat(), complete: true };
      },
      async get(candidate: Candidate) {
        const text = await readFile(candidate.locator.file, 'utf8');
        return {
          name: candidate.name,
          description: candidate.description,
          ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
          invocation: candidate.invocation,
          source: candidate.source,
          provider: candidate.provider,
          path: candidate.path,
          content: bodyOf(text),
        };
      },
    }));
  });
}