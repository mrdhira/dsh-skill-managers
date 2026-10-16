# AGENTS.md — dsh-skill-managers

Project-level instructions. These **add** to `~/.dsh/AGENTS.md` (the user-global brain) and never
weaken it. Precedence, always: safety > truth > persona.

## Who commits

**Every commit in this repository is authored and committed by Dhira Wigata
`<dwigata.putra@gmail.com>`. Nobody else is credited.**

1. **No `Co-authored-by`.** Ever. Not for an agent, not for a teammate. The trailer implies shared
   authorship of a claim this repository makes about one person.
2. **No agent bylines or footers.** `Generated with …`, `🤖 Generated with …`, `Assisted-by:`,
   `Co-developed-by:`, `Generated-by:` — none of them, in the subject or the body.
3. **Agents assist; they do not author.** Work an agent did is described in the commit *body* as
   prose ("Evidence: …"), never as an authorship trailer.
4. **`Signed-off-by:` is allowed** — it is Dhira's own sign-off, not a second author.
5. **CI is the gate.** `.github/workflows/ci.yml` checks the whole history — one identity, no
   authorship trailers — and runs build, typecheck and the suite. There is no local hook, so
   `--no-verify` does not get a commit past CI.

Identity is set **repo-locally**, so it applies here and nowhere else:

```bash
git config --local user.name  "Dhira Wigata"
git config --local user.email "dwigata.putra@gmail.com"
```

See `~/.dsh/rules/GIT-AUTHORSHIP.md` for the rule and its incident anchor.

## The loop — how work happens here

```
SCOPE    one write scope, one owner.
ACT      the smallest correct change. No feature nobody asked for.
VERIFY   a gate that can actually run: build + typecheck + tests against built output.
LEARN    a correction becomes durable (a rule or a doc), never a chat apology.
STOP     acceptance met, or the same failure twice — then re-plan, never grind.
REPORT   changed / why / evidence / unverified.
```

## Gates

- **Cap every `node` run through the guard.** `scripts/guard.mjs` is a byte-identical copy of the
  canonical `~/.dsh/scripts/guard/guard.mjs`. Run the suite through `pnpm test`, which carries the
  cap. **Exit 124 means the cap was hit — bisect, never raise it.** One run at a time.
- **Tests import built artifacts.** `lib/**` is generated and gitignored; `pnpm test` builds first via
  `pretest`, and `prepare` builds on install so a fresh clone is runnable at all.
- **`lib/**` is never hand-edited.** Authored in TypeScript, built with esbuild.
- **A client half is not done until the slot inspector says `active: true`.**
- **Client change → toggle the bundle. Host change → restart the app.** A page reload does neither.
- **Never assert on a DOM node.** Compare primitives (`assert.ok(node === null)`).

## Names — one identity, five places

The plugin's name is its Loader identity, so a rename is not a rename unless all of these move
together, and the built bundles are regenerated afterwards:

| Place | Value |
|---|---|
| `package.json` → `name` | `dsh-skill-managers` |
| `src/host/index.ts` → `export const name` | `dsh-skill-managers` |
| `src/client/index.cts` → `PLUGIN_ID` | `dsh-skill-managers` |
| `cordis.patch.yml` → row `name` | `dsh-skill-managers` |
| the profile's `dependencies` link + `dsh.profile.bundles` | `dsh-skill-managers` |

The row **id** (`skills-manager`) and the provider id (`skills-manager-roots`) are deliberately
different names and must not be renamed with it.

A rename also needs the app **restarted**: the host half loads once per process.

## Layout

```
src/host/index.ts     the global skill provider that scans the discovery roots -> lib/v1/index.js
src/client/index.cts  sidebar entry, page, categories, catalog fetch          -> lib/v1/client.js
types/dsh.d.ts        observed (not published) DSH contract declarations
build.mjs             esbuild: host ESM unbundled, client CJS + loader handshake
install.sh            register/unregister in a profile (--check, --profile, --remove)
```

## Deployment

Installed into a DSH profile by **link**, never published to npm (`private: true`). `install.sh`
registers it; the host half then needs a full quit and reopen. See `README.md` for the manual steps.