# Changelog

All notable changes to this plugin. The version appears in the build id, so it identifies which
generation of the halves the app is running.

## [1.0.0] — 2026-10-16

### Added

- **Skills page** (`sidebar.panellist` → `main`): every skill DSH can see, grouped **All · Global ·
  Workspaces**, with search, copy-command, per-skill origin, and the roots DSH discovers from.
- **A global skill provider** that scans the discovery roots itself (`~/.dsh/skills`,
  `~/.agents/skills`, and each registered workspace's `.dsh/skills` / `.agents/skills`), ranked to
  mirror `@deepseek-ai/dsh-skill-filesystem` so a duplicate name resolves the same way it does inside
  a preset.
- **Repository tooling**: `LICENSE`, `AGENTS.md`, `.gitignore`, `.gitattributes`, `.gitmessage`, a CI
  job that builds, typechecks and tests, and an `authorship` job over the whole history.
- **`install.sh`** with `--profile`, `--check` and `--remove`, so the plugin can be registered from a
  clone anywhere rather than only in place.

### Fixed

- **Half the catalog was invisible.** `skills/list` is session-addressed and DSH disables the base
  `skill-filesystem` row ("presets own local discovery"), so `~/.dsh/skills` and
  `<workspace>/.dsh/skills` are visible only inside a *live agent's* preset scope. A cold session
  fell back to the global registry, which carries no filesystem provider, and the page showed four
  pathless entries and nothing else. The host half now registers a global provider; because the
  catalog falls back to the global layer, every session sees the complete set.
- **A fresh clone was not runnable.** `main` points at `lib/v1/index.js`, which `.gitignore`
  excludes, and there was no `prepare` script — so `pnpm install` succeeded and the plugin could
  never load. `prepare` now builds it.
- **`pnpm run` and `pnpm test` exited 1 on a fresh clone** with `ERR_PNPM_IGNORED_BUILDS`: pnpm 11
  blocks dependency build scripts, and no `pnpm-workspace.yaml` was committed. `allowBuilds:
  { esbuild: true }` is now tracked.
- **`install.sh` required the checkout to sit inside the profile** (`dirname $HERE`). It now
  discovers `~/.dsh/profiles/desktop`, accepts `--profile`, and builds before registering.

### Changed

- **Renamed from `dsh-skills-manager` to `dsh-skill-managers`** across all five identity sites: the
  package name, the host half's exported `name`, the client half's `PLUGIN_ID`, the Loader row in
  `cordis.patch.yml`, and the profile's dependency link and bundles list. The row id
  (`skills-manager`) and provider id (`skills-manager-roots`) are separate identities and did not
  move.
- **The test suite is TypeScript and typechecked.** 764 lines of `.js`/`.mjs` tests were included by
  no tsconfig, while `tsconfig.test.json` existed with `checkJs: false` and was never invoked. Both
  files are now `test/**/*.ts` with real types, the jsdom realm is a shared `test/harness.ts`, and
  `tsconfig.test.json` is wired into `pnpm typecheck` — three projects.
- **Added `test/build.test.ts`**: artifacts must exist, must not predate their source, must resolve
  inside the package, and the client bundle must carry a build id naming the package and version.

Typing the tests found four defects immediately, all previously invisible:

1. `entry.definition.label?.()` assumed a callable; the contract is `string | (() => string)`, so the
   assertion would have thrown on a string label.
2. `Simulate.change(node, { target: { value } })` is not assignable to React's event type — now an
   explicit, commented cast rather than a silent `any`.
3. The VM sandbox omitted `AbortController`, which this bundle constructs to abort an in-flight
   catalog read when the session changes; four client tests crashed until the realm matched.
4. The browser half was `strict: false, noImplicitAny: false` — vestigial, since it is strict-clean;
   it is now `strict: true`.