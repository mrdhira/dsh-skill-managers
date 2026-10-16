/**
 * Build both halves of the plugin.
 *
 * The host half is ESM for the Loader; the browser half is the lazy CommonJS factory the
 * client module loader evaluates, exactly as a hand-written bundle would be. Nothing is
 * bundled from outside this package: `@deepseek-ai/*`, react, react-dom and scheduler stay
 * external, which is also what the client bundle-purity gate requires.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const buildId = `${pkg.name}/${pkg.version}+${stamp}`;
// `.cts` marks the browser half as CommonJS to both esbuild and tsc: the loader's factory
// returns `module.exports`, and `package.json` is `"type": "module"` for the host half.
const shared = { bundle: true, logLevel: 'info', define: { __BUILD_ID__: JSON.stringify(buildId) } };

// The host half is emitted per module rather than bundled
await build({
  ...shared,
  bundle: false,
  entryPoints: ['src/host/index.ts'],
  outdir: 'lib/v1',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

await build({
  ...shared,
  entryPoints: ['src/client/index.cts'],
  outfile: 'lib/v1/client.js',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: ['react', 'react-dom', 'scheduler', '@deepseek-ai/*'],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports; // ${buildId}`,
  },
  footer: { js: 'return module.exports; } });' },
});
