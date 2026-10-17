/**
 * Headless visual capture of the Skills page — both themes, two states, committed as PNGs.
 *
 * Why this exists: the page was only ever looked at in the dark theme, in the app, by a
 * human. The running app has no debugging port and must not be restarted, so this renders
 * the page's **real DOM and real CSS** off-screen instead of screenshotting the app.
 *
 * How it stays honest:
 *
 * - the markup comes from `test/harness.ts` — the same `loadBundle()` / `mount()` /
 *   `renderPage(...)` path `test/client.test.ts` uses: the real bundle, the real restricted
 *   context, the fake `skills` Remote, and the same `useSessions` / `useWorkspaces`
 *   selector hooks. Nothing here re-implements a component or hand-writes a mock;
 * - the stylesheet is the one the bundle itself injects (`<style data-plugin-css>`), read
 *   back out of the jsdom document, so it is the shipped CSS and not a copy of it;
 * - the `--dsw-*` tokens are the app's own declarations, extracted from the shipped
 *   `app.asar` by `scripts/lib/app-aspect.mts` and emitted under the app's own selectors
 *   (`body` for light, `body[data-ds-dark-theme]` for dark). The dark page carries that
 *   marker on `<body>`, and a computed-style probe asserts the page really resolved to the
 *   dark tokens before a dark PNG is written;
 * - the width is the centre column the app's own `computeColumns()` would give this page,
 *   evaluated from the layout bundle in the same asar — not a guessed number.
 *
 * The second state is not a variant fixture: it is the same page after a real click on the
 * **Global** tab and a real click on a skill's **show path** toggle, so the filtered view
 * and the expanded row are the ones the component actually renders.
 *
 * One thing it deliberately does **not** model, so nobody reads more into a PNG than is
 * there: the page is rendered in a plain block at the centre-column width, not inside the
 * app shell, so the PNG shows the page's own geometry (its 900px inner column and its own
 * padding) and not where the shell would put it.
 *
 * Run (through the guard, as every node run must be):
 *   node ~/.dsh/scripts/guard/guard.mjs --limit-mb 2560 -- \
 *     node --max-old-space-size=384 \
 *     ~/.dsh/profiles/desktop/plugins/dsh-skill-managers/scripts/capture-panel.mts
 *
 * The cap is 2560 MB, not the suite's 1024 MB, for a measured reason: this script's Node
 * half peaks at a few tens of MB (jsdom, one realm), but the headless Chrome it spawns
 * needs ~1.35 GB of process tree on macOS just to start (the reference measurement for a
 * blank page through these `--disable-*` flags: 1352 MB of 1639 MB). A 1024 MB cap kills
 * the tree before a single screenshot is written; 2560 MB still protects the run, because
 * a genuine leak would blow far past it. One Chrome runs at a time, sequentially.
 *
 * Nothing is cached and nothing is snapshotted: the bundle, the harness and the asar are
 * read fresh, so the script can be re-run after any client change.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadBundle,
  mount,
  openSessions,
  renderPage,
  sessionsSnapshot,
  settle,
  useWorkspacesOver,
  type MountedView,
  type Registration,
  type SkillRow,
  type SkillsRemote,
  type WorkspaceRow,
} from '../test/harness.ts';
import { ASAR_PATH, designTokens, layoutArithmetic, resolve, type Tokens } from './lib/app-aspect.mts';

// ------------------------------------------------------------------ paths

const BUNDLE_PATH = fileURLToPath(new URL('lib/v1/client.js', new URL('..', import.meta.url)));
const OUT_DIR = fileURLToPath(new URL('docs/screenshots', new URL('..', import.meta.url)));
const TEMP_DIR = join(tmpdir(), `dsh-skill-managers-capture-${String(process.pid)}`);

/** Chrome, in the two places it lives on macOS. Missing means a sentence, not a blank PNG. */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

// ------------------------------------------------------------------ the frame

/**
 * The viewport the capture presents.
 *
 * The app opens at whatever size the window is; `computeColumns` is viewport-driven and the
 * sidebar preference is the store's first-open 280, so the centre column this page occupies
 * is a function of this number. 1440×900 is named here as the representative window — the
 * derived width is printed at run time and follows the app if the arithmetic changes.
 */
const VIEWPORT = { width: 1440, height: 900 };

const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

// ------------------------------------------------------------------ the fixture

/**
 * The catalog the page lists, shaped exactly as `skills/list` carries it.
 *
 * The rows are the shapes the page classifies: a workspace skill, two in the global
 * `~/.dsh/skills` root, one in `~/.agents/skills`, a shipped bundled skill with no path, a
 * plugin-registered one with no path, and a model-invisible one — the badge and the four
 * origin labels all get a row. Paths are the repository's own test placeholders, not this
 * machine's home directory.
 */
const SKILLS: readonly SkillRow[] = [
  { name: 'caveman', description: 'Terse caveman voice: answer first, fluff gone.', modelInvocable: true, path: '/home/u/work/app/.dsh/skills/caveman/SKILL.md' },
  { name: 'release-notes', description: 'Turns a merged range into a changelog a human will read.', modelInvocable: true, path: '/home/u/work/app/.dsh/skills/release-notes/SKILL.md' },
  { name: 'ponytail', description: 'Forces the laziest solution that actually works.', modelInvocable: true, path: '/home/u/.dsh/skills/ponytail/SKILL.md' },
  { name: 'sql-explain', description: 'Reads a query plan and says which index is missing.', modelInvocable: true, path: '/home/u/.dsh/skills/sql-explain/SKILL.md' },
  { name: 'incident-postmortem', description: 'Drafts a blameless postmortem from a timeline.', modelInvocable: false, path: '/home/u/.agents/skills/incident-postmortem/SKILL.md' },
  { name: 'office-docx', description: 'Creates and edits Word documents.', modelInvocable: true },
  { name: 'office-xlsx', description: 'Creates and edits Excel workbooks.', modelInvocable: true },
  { name: 'agent-experience', description: 'Records what an agent learned so the next session starts warmer.', modelInvocable: true },
];

/** One registered workspace, so the workspace group and the `Workspaces` tab have content. */
const WORKSPACES: readonly WorkspaceRow[] = [
  { workspaceId: 'w1', path: '/home/u/work/app', title: 'default-workspace' },
];

/** A `skills` Remote that answers the fixture, recording the session it was asked for. */
function skillsReturning(rows: readonly SkillRow[], asked: string[] = []): SkillsRemote {
  return {
    list: (request) => {
      asked.push(request.sessionId);
      return Promise.resolve({ ok: true, value: { skills: rows } });
    },
  };
}

/**
 * Render the page once with the props its slot owner passes.
 *
 * `mount([], deps)` re-applies the plugin to the fake context and collects its two
 * registrations; `renderPage` then mounts the `main` component with the same
 * `useSessions` / `useWorkspaces` hooks `test/client.test.ts` hands it.
 */
async function renderPageWith(rows: readonly SkillRow[], workspaces: readonly WorkspaceRow[]): Promise<{ view: MountedView; registrations: Registration[] }> {
  const skills = skillsReturning(rows);
  const sessions = openSessions();
  const registrations = mount([], { sessions, skills, workspaces });
  const view = await renderPage(registrations, {
    useSessions: () => sessionsSnapshotOf([{ id: 's1', retainedBy: { mainView: 1 } }]),
    useWorkspaces: useWorkspacesOver(workspaces),
    skmDeps: { sessions, skills },
  });
  return { view, registrations };
}

/**
 * The sessions snapshot the harness's own cases use.
 *
 * Taken from the harness rather than rebuilt here: the page reads the snapshot through the
 * `useSessions` selector hook its slot owner passes, and nothing about the capture should
 * exercise a snapshot shape the tests never do.
 */
const sessionsSnapshotOf = sessionsSnapshot;

/** The strip of classes the fixture exercises, asserted so a silently empty page cannot pass. */
const EXPECTED_CLASSES = ['skm-page', 'skm-tabs', 'skm-row', 'skm-input'];

// ------------------------------------------------------------------ the page

/**
 * One HTML page: the app's token blocks, the plugin's own stylesheet, the markup.
 *
 * The token blocks carry the app's selectors verbatim — `body`, `body[data-ds-dark-theme]`
 * and their two darwin variants — and the dark page sets `data-ds-dark-theme` on `<body>`
 * exactly as the app does. That is what makes the app's own dark-scoped rules live in the
 * capture instead of being simulated by the injected values.
 */
function htmlDocument(args: {
  theme: Theme;
  tokens: Tokens;
  styles: string;
  markup: string;
  centerWidth: number;
  probe?: boolean;
}): { html: string; unresolved: string[] } {
  // The frame's own tokens come first. They must be resolved whether or not the plugin's
  // stylesheet happens to name them: the first version of this script derived the set only
  // from the plugin's CSS, so a plugin that never writes `--dsw-alias-bg-base` left the
  // page's background on the literal `#fff` fallback and the dark PNG was written light.
  // The probe caught it, which is what the probe is for.
  const frame = ['--dsw-alias-bg-base', '--dsw-alias-label-primary'];
  const referenced = [
    ...new Set([...frame, ...[...args.styles.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1] as string)]),
  ].sort();
  const set = args.theme === 'dark' ? args.tokens.dark : args.tokens.light;
  const unresolved: string[] = [];
  const resolved = new Map<string, string>();
  for (const token of referenced) {
    const value = resolve(token, set);
    if (value === null) unresolved.push(token);
    else resolved.set(token, value);
  }

  const selectors = args.tokens.selectors.filter((selector) =>
    args.theme === 'dark' ? selector.includes('data-ds-dark-theme') : !selector.includes('data-ds-dark-theme')
  );
  const blocks = selectors
    .map((selector) => {
      const declarations = [...resolved].map(([name, value]) => `  ${name}: ${value};`).join('\n');
      return `${selector} {\n${declarations}\n}`;
    })
    .join('\n');

  const bodyMarker = args.theme === 'dark' ? ' data-ds-dark-theme' : '';
  const htmlMarker = platform() === 'darwin' ? ' data-platform="darwin"' : '';

  // Sizes the window to the content: the page is a real full-height panel in the app, but a
  // PNG of 900px of empty scrollback is not a screenshot of anything.
  const probeScript = args.probe
    ? `
<script>
window.addEventListener('DOMContentLoaded', function () {
  var out = { body: getComputedStyle(document.body).backgroundColor, height: 0, page: null };
  var node = document.getElementById('dsh-surface');
  if (node !== null) out.height = Math.ceil(node.getBoundingClientRect().height);
  var page = document.querySelector('.skm-page');
  if (page !== null) out.page = getComputedStyle(page).color;
  var pre = document.createElement('pre');
  pre.id = 'dsh-capture-probe';
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
});
</script>`
    : '';

  const html = `<!doctype html>
<html${htmlMarker} data-dsh-theme="${args.theme}">
<head>
<meta charset="utf-8" />
<style>
${blocks}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: 100%; min-height: 100%; }
body {
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-primary, #0f1115);
  font-family: var(--dsw-font-family, ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif);
}
/* The page is height:100% + overflow:auto in the app, where the shell gives it a track. In
   a standalone document that resolves to the viewport, so the frame gives it its own box. */
#dsh-surface { width: ${String(args.centerWidth)}px; margin: 0 auto; overflow: hidden; }
#dsh-surface .skm-page { height: auto; overflow: visible; }
${args.styles}
</style>
</head>
<body${bodyMarker}>
<div id="dsh-surface">
${args.markup}
</div>${probeScript}
</body>
</html>
`;
  return { html, unresolved };
}

// ------------------------------------------------------------------ capture

/** Screenshot one HTML file with one headless Chrome, at an exact window size. */
function screenshot(chrome: string, file: string, out: string, width: number, height: number): void {
  const result = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--disable-extensions',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-component-update',
      '--disable-background-networking',
      `--window-size=${String(width)},${String(height)}`,
      `--screenshot=${out}`,
      '--run-all-compositor-stages-before-draw',
      '--virtual-time-budget=2000',
      `file://${file}`,
    ],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`headless Chrome exited ${String(result.status)}: ${(result.stderr ?? '').split('\n').slice(-3).join(' ')}`);
  }
}

/** A PNG's real pixel dimensions, so a capture that silently rendered wrong cannot pass. */
function pngSize(path: string): { width: number; height: number; bytes: number } {
  const buffer = readFileSync(path);
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length };
}

/** Run the probe page and read the computed values it reported. */
function probeComputed(chrome: string, file: string): Record<string, string | null> {
  const result = spawnSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-component-update',
      '--disable-background-networking',
      '--virtual-time-budget=3000',
      '--dump-dom',
      `file://${file}`,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(`the computed-style probe exited ${String(result.status)}`);
  }
  const match = /<pre id="dsh-capture-probe">([^<]*)<\/pre>/.exec(result.stdout ?? '');
  if (match === null) throw new Error(`the computed-style probe did not run in ${file}`);
  return JSON.parse(match[1] as string) as Record<string, string | null>;
}

/** A resolved token as the `rgb(...)` string `getComputedStyle` returns. */
function cssColor(value: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex === null) return value.trim();
  const digits = hex[1] as string;
  const full = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
  const int = Number.parseInt(full, 16);
  return `rgb(${String((int >> 16) & 0xff)}, ${String((int >> 8) & 0xff)}, ${String(int & 0xff)})`;
}

/** Sum a hex colour's channels, for the light-is-lighter assertion. */
function luminance(value: string): number {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex === null) return Number.NaN;
  const digits = hex[1] as string;
  const full = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
  const int = Number.parseInt(full, 16);
  return ((int >> 16) & 0xff) + ((int >> 8) & 0xff) + (int & 0xff);
}

async function main(): Promise<void> {
  const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
  if (chrome === undefined) {
    throw new Error(`no headless Chrome at ${CHROME_CANDIDATES.join(' or ')} — nothing was written`);
  }
  if (!existsSync(ASAR_PATH)) throw new Error(`no app bundle at ${ASAR_PATH}`);
  statSync(BUNDLE_PATH); // fail loudly when the bundle has not been built

  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  const tokens = designTokens();
  const layout = layoutArithmetic();
  const columns = layout.computeColumns(VIEWPORT.width, layout.firstOpenSidebar, 0);
  console.log(`[layout] computeColumns(${String(VIEWPORT.width)}, ${String(layout.firstOpenSidebar)}, 0) => ${JSON.stringify(columns)}`);
  console.log(`[width ] page surface: ${String(columns.center)}px centre column at ${String(VIEWPORT.width)}×${String(VIEWPORT.height)}`);

  const lightBase = resolve('--dsw-alias-bg-base', tokens.light);
  const darkBase = resolve('--dsw-alias-bg-base', tokens.dark);
  console.log(`[tokens] body -> --dsw-alias-bg-base => ${String(lightBase)}`);
  console.log(`[tokens] body[data-ds-dark-theme] -> --dsw-alias-bg-base => ${String(darkBase)}`);
  if (lightBase === null || darkBase === null) throw new Error('could not resolve --dsw-alias-bg-base in both themes');
  if (!(luminance(lightBase) > luminance(darkBase))) {
    throw new Error(`light/dark look swapped: body=${lightBase} is not lighter than dark=${darkBase}`);
  }

  const pluginCss = [...loadBundle().dom.window.document.querySelectorAll('style[data-plugin-css]')]
    .map((node) => node.textContent ?? '')
    .join('\n');
  if (pluginCss.trim().length === 0) throw new Error('the bundle injected no stylesheet; nothing to render');
  console.log(`[styles] ${String(pluginCss.length)} chars from <style data-plugin-css> in the evaluated bundle`);

  // State one: the page as it opens. State two: the same page after real interaction.
  const first = await renderPageWith(SKILLS, WORKSPACES);
  const allState = first.view.container.innerHTML;
  for (const className of EXPECTED_CLASSES) {
    if (!allState.includes(className)) throw new Error(`the page rendered without .${className}`);
  }
  first.view.unmount();

  const second = await renderPageWith(SKILLS, WORKSPACES);
  const globalTab = [...second.view.container.querySelectorAll('.skm-tab')].find((node) =>
    (node.textContent ?? '').startsWith('Global')
  );
  if (globalTab === undefined) throw new Error('the Global tab did not render');
  await second.view.clickNode(globalTab);
  const toggle = second.view.container.querySelector('.skm-pathtoggle');
  if (toggle === null) throw new Error('no path toggle rendered to expand');
  await second.view.clickNode(toggle);
  await settle(400);
  const globalState = second.view.container.innerHTML;
  if (globalState === allState) throw new Error('the second state is identical to the first; the clicks did not change it');
  second.view.unmount();
  console.log(`[render] all ${String(allState.length)} chars; global+path ${String(globalState.length)} chars`);

  const surfaces = [
    { name: 'page', markup: allState },
    { name: 'page-global', markup: globalState },
  ];

  const written: string[] = [];
  const fallbacks: string[] = [];

  for (const theme of THEMES) {
    for (const surface of surfaces) {
      const page = htmlDocument({ theme, tokens, styles: pluginCss, markup: surface.markup, centerWidth: columns.center });
      for (const token of page.unresolved) fallbacks.push(`${theme}/${surface.name}: ${token}`);
      const file = join(TEMP_DIR, `${surface.name}-${theme}.html`);
      writeFileSync(file, page.html, 'utf8');

      const probeFile = join(TEMP_DIR, `${surface.name}-${theme}-probe.html`);
      writeFileSync(
        probeFile,
        htmlDocument({ theme, tokens, styles: pluginCss, markup: surface.markup, centerWidth: columns.center, probe: true }).html,
        'utf8'
      );
      const computed = probeComputed(chrome, probeFile);
      const expected = cssColor(theme === 'dark' ? (darkBase as string) : (lightBase as string));
      if (computed.body !== expected) {
        throw new Error(`${theme}: the page computed body ${String(computed.body)}, expected ${expected} — the dark marker is not scoping the capture`);
      }
      const measured = Number(computed.height);
      if (!Number.isFinite(measured) || measured < 100) throw new Error(`${theme}/${surface.name}: the page measured ${String(computed.height)}px tall`);

      const width = columns.center;
      const height = measured;
      console.log(`[probe ] ${theme.padEnd(5)} ${surface.name.padEnd(11)} body ${String(computed.body)}; page ${String(measured)}px tall`);

      const out = join(OUT_DIR, `${surface.name}-${theme}.png`);
      screenshot(chrome, file, out, width, height);
      const png = pngSize(out);
      if (png.bytes < 2000) throw new Error(`${out} is only ${String(png.bytes)} bytes — the capture looks blank`);
      if (png.width !== width || png.height !== height) {
        throw new Error(`${out} is ${String(png.width)}×${String(png.height)}, expected ${String(width)}×${String(height)}`);
      }
      written.push(`${surface.name}-${theme}.png  ${String(png.bytes)} bytes  ${String(png.width)}×${String(png.height)}`);
    }
  }

  if (process.env.SKILL_MANAGERS_CAPTURE_KEEP_TEMP !== '1') rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log(`\n[summary] ${String(written.length)} PNGs written to ${OUT_DIR}`);
  for (const line of written) console.log(`  ${line}`);
  if (fallbacks.length > 0) {
    console.log('\n[fallback] tokens not defined by the app (the plugin\'s own literal fallback applies):');
    for (const line of [...new Set(fallbacks)]) console.log(`  ${line}`);
  } else {
    console.log('\n[fallback] every referenced token resolved from the app bundle');
  }
}

await main();
