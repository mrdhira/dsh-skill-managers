# dsh-skill-managers

A **Skills** page for the DSH Web GUI — its own sidebar entry beside *Plugins*, listing every skill
DSH can see, grouped as **All · Global · Workspaces**, with search, copy-command, per-skill origin,
and the roots DSH discovers skills from.

It exists because DSH hides most of your skills from a cold session. See
[Why this plugin has a host half](#why-this-plugin-has-a-host-half) — it is the whole reason for the
plugin, and the interesting part of its design.

## What you get

```
┌ Skills ─────────────────────────────────── [ search ]  [ Refresh ]
│ 17 skills · 4 in a workspace
│
│  All 17   Global 13   Workspaces 4
│
│  WORKSPACE · default-workspace                    4
│  workspace  /caveman                                    [ Copy ]
│  Terse caveman voice: answer first, fluff gone.         ▶ show path
│
│  GLOBAL                                          13
│  global  /ponytail                                      [ Copy ]
│  Forces the laziest solution that actually works.       ▶ show path
│
│  BUNDLED                                          3
│  bundled  /office-docx                                  [ Copy ]
└──────────────────────────────────────────────────────────────────
```

| Category | What it shows |
|---|---|
| **All** | Everything the provider found, grouped by origin |
| **Global** | `~/.dsh/skills`, `~/.agents/skills`, bundled, and other non-project roots |
| **Workspaces** | Skills under each registered workspace's `.dsh/skills` / `.agents/skills` |

Workspaces come from the live `workspaces` service, so a new workspace appears without a code change
or a restart.

### Origins

`skills/list` returns only `{ name, path?, description, whenToUse?, modelInvocable }` — `source`,
`provider` and `resourceBase` are stripped. Origin is therefore derived from the path, with one
honest exception: a skill whose provider supplies no path (bundled Office, or a `skills.register()`
call) is labelled **bundled** rather than implying an error.

| Label | Matched when |
|---|---|
| `workspace` | the path is under a registered workspace |
| `global` | the path contains `/.dsh/skills/` or `/.agents/skills/` |
| `bundled` | no path, or a shipped root (`dsh-agent-preset/skills`, `office-skills`) |
| `other` | anywhere else |

### Roots scanned

| Rank | Root | Source |
|---|---|---|
| 100 | `<workspace>/.dsh/skills` | `project-dsh` |
| 200 | `<workspace>/.agents/skills` | `project-agents` |
| 400 | `~/.dsh/skills` | `user-dsh` |
| 500 | `~/.agents/skills` | `user-agents` |
| 600 | shipped with the app | `bundled` (app providers) |

Ranks mirror `@deepseek-ai/dsh-skill-filesystem`, so a duplicate name resolves the same way it does
inside a preset.

## Install

The plugin is installed into your DSH **profile** by linking it — it is not published to npm, so the
clone is the source. There are two ways in; both end with a **restart**.

### Option A — the script

```bash
git clone https://github.com/mrdhira/dsh-skill-managers.git ~/.dsh/plugins/dsh-skill-managers
cd ~/.dsh/plugins/dsh-skill-managers
./install.sh                 # builds, registers in your profile, runs pnpm install
```

It accepts `--profile <dir>` to target a profile other than `~/.dsh/profiles/desktop`, `--check` to
report what would change without writing anything, and `--remove` to unregister.

### Option B — the manual steps

**1. Clone somewhere stable** (this path becomes your install path):

```bash
git clone https://github.com/mrdhira/dsh-skill-managers.git ~/.dsh/plugins/dsh-skill-managers
cd ~/.dsh/plugins/dsh-skill-managers
```

**2. Build it.** `pnpm install` runs the `prepare` script, which builds `lib/**` — the part DSH
actually loads. It is generated, and never hand-edited:

```bash
pnpm install
```

**3. Register it with your profile.** In your profile's `package.json`, add the dependency and the
bundle name. Use an absolute path:

```json
{
  "dependencies": {
    "dsh-skill-managers": "link:/Users/<you>/.dsh/plugins/dsh-skill-managers"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-skill-managers"
      ]
    }
  }
}
```

**4. Install the link, then restart DSH:**

```bash
cd ~/.dsh/profiles/desktop && pnpm install
```

There is nothing to add by hand to `cordis.patch.yml`: the bundle declares its own Loader row.

> **Restart, don't reload.** The host half is loaded once per app process, so a host-side change needs
> a full quit and reopen (`⌘Q`, then reopen) — a page reload does not pick it up. A client-side (UI)
> change needs the bundle toggled in the plugin manager.

### Verify it is really working

A **Skills** entry should appear in the sidebar beside *Plugins*, listing your skills. If it does
not, check that:

- `lib/v1/index.js` exists — if not, `pnpm install` did not finish building;
- the profile's `package.json` names `dsh-skill-managers` in **both** `dependencies` and
  `dsh.profile.bundles`;
- DSH was **restarted** after installing (the host half loads once, at startup).

Two ways to see it clearly:

```bash
# the host half answers with its Loader identity
node -e "import('./lib/v1/index.js').then(m => console.log(m.name))"   # dsh-skill-managers

# what the page will list, straight from the roots (no DSH needed)
find ~/.dsh/skills ~/.agents/skills -maxdepth 2 -name SKILL.md 2>/dev/null
```

## Why this plugin has a host half

The client reaches skills through `skills/list` — a **session-addressed** Remote. DSH deliberately
keeps filesystem discovery *out* of the host layer:

```yaml
# dsh-web-app/cordis.patch.yml
# the base host `skill-filesystem` row is disabled here (presets own local discovery)
- id: skill-filesystem
  disabled: true
```

So `~/.dsh/skills` and `<workspace>/.dsh/skills` exist only inside a **live agent's** preset scope. A
cold session falls back to the global layer:

```js
// dsh-api-session-controller/lib/types/skill-catalog.js
const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills');
const skillRegistry = scoped ?? this.ctx.get('skills');   // ← cold session
```

The global layer carries no filesystem provider, so a cold session sees only deployment-level skills
— which is exactly what the first version of this page showed: four pathless entries (three Office
skills plus a plugin-registered one) and nothing from `~/.dsh/skills`.

The fix is not to view per session. It is to **register a global provider** that scans the roots
itself (`src/host/index.ts`). Because the catalog falls back to the global layer, every session then
sees the complete set, and the browser half is free to present categories rather than sessions. The
session remains only as transport.

## Requirements

- **DSH** with the Web GUI, and a profile you can edit (`~/.dsh/profiles/<profile>/`).
- **Node.js 22+** and **pnpm** to build from source. The built artifact needs nothing extra at runtime.

## Development

```bash
pnpm install        # deps + build (prepare)
pnpm build          # src/** -> lib/v1/**
pnpm typecheck      # host, then browser half
pnpm test           # builds first, then runs every test (21 tests)
```

```
src/host/index.ts     the global skill provider that scans the discovery roots -> lib/v1/index.js
src/client/index.cts  sidebar entry, page, categories, catalog fetch          -> lib/v1/client.js
types/dsh.d.ts        observed (not published) DSH contract declarations
test/host.test.mjs    provider coverage against real temp trees
test/client.test.js   jsdom + React coverage of the page
build.mjs             esbuild: host ESM unbundled, client CJS + loader handshake
cordis.patch.yml      the one Loader row the bundle contributes
```

`src/client/index.cts` is CommonJS to both esbuild and tsc (`.cts`), because the loader's factory
returns `module.exports`; `build.mjs` wraps it in the `window.__ModuleLoader__.load({…})` handshake.
`src/host/index.ts` is ESM for the Loader.

**Build before you test.** The tests import the generated `lib/**`, so a run against a stale build is
green and wrong. `pnpm test` builds for you via `pretest`.

## Contributing

Issues and pull requests are welcome. `AGENTS.md` describes the project's conventions and the gates a
change must pass — build, typecheck and the test suite — before it can be merged.

## Licence

[MIT](LICENSE) © Dhira Wigata