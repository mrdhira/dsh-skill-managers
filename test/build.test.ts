/**
 * Build-artifact contract tests.
 *
 * These exist because of a real failure, in a sibling plugin: `lib/v1/*.js` held stale
 * bytes while the suite imported them, so every test passed against code that was no
 * longer shipped. The rule this file enforces is the one the suite assumes — **tests run
 * against what ships**.
 *
 * `lib/**` is generated, so it must exist, mirror `src/**`, be no older than it, and
 * resolve every import inside the published package.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  main: string;
  exports: Record<string, unknown>;
  dsh: { client: { platform: string; immediately: boolean } };
};

/** Source module -> built artifact. The host half is unbundled, so it is one for one. */
const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['src/host/index.ts', 'lib/v1/index.js'],
  ['src/client/index.cts', 'lib/v1/client.js'],
];

const exists = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

test('build: every source module has an artifact, and no artifact predates its source', () => {
  const missing = PAIRS.filter(([, artifact]) => !exists(root + artifact)).map(([, artifact]) => artifact);
  assert.deepEqual(missing, [], 'run `pnpm run build`: these artifacts do not exist');

  const stale = PAIRS.filter(([source, artifact]) => statSync(root + artifact).mtimeMs < statSync(root + source).mtimeMs);
  assert.deepEqual(
    stale.map(([source]) => source),
    [],
    'these sources are newer than their artifacts, so the suite would validate stale bytes — run `pnpm run build`'
  );
});

test('build: the entrypoints the Loader reads are the files that exist', () => {
  assert.equal(exists(root + pkg.main.replace('./', '')), true, `main points at a missing file: ${pkg.main}`);
  for (const [key, value] of Object.entries(pkg.exports)) {
    const target =
      typeof value === 'string' ? value : (value as { default?: string }).default;
    if (target === undefined) continue;
    assert.equal(exists(root + target.replace('./', '')), true, `exports["${key}"] points at a missing file: ${target}`);
  }
  assert.equal(pkg.dsh.client.platform, 'web', 'the browser half declares its platform');
  assert.equal(pkg.dsh.client.immediately, true, 'and loads with the page rather than on demand');
});

test('build: no generated file imports something the package does not publish', () => {
  const files = readdirSync(root + 'lib/v1').filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 2, 'the build should have produced both halves');
  const broken: string[] = [];
  for (const name of files) {
    const text = readFileSync(root + 'lib/v1/' + name, 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.\/[^"']+)["']/g)) {
      if (!exists(root + 'lib/v1/' + match[1].replace('./', ''))) broken.push(`${name} -> ${match[1]}`);
    }
  }
  assert.deepEqual(broken, [], 'these relative imports do not resolve inside lib/v1');
});

test('build: the shipped client carries a build id naming the package and version', () => {
  const bundle = readFileSync(root + 'lib/v1/client.js', 'utf8');
  const expected = `${pkg.name}/${pkg.version}+`.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  assert.match(bundle, new RegExp(expected), 'a generation must be identifiable from the bundle alone');
  assert.match(bundle, /window\.__ModuleLoader__\.load\(\{ id: "dsh-skill-managers"/, 'the handshake names the package');
  assert.match(bundle, /return module\.exports; \} \}\);/, 'and closes by returning the plugin to the loader');
});