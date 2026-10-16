/**
 * Host-half coverage for `src/host/index.ts` → `lib/v1/index.js`.
 *
 * The host half is the fix for the original defect: `skills/list` is session-addressed and
 * falls back to the global layer for a cold session, where no filesystem provider is
 * mounted. This half registers a *global* provider that scans the real roots, so these
 * tests build a real temp tree and assert what the provider returns for it.
 *
 * The provider contract is checked against the same rules the shipped registry enforces
 * (`@deepseek-ai/dsh-skill`): kebab-case names, a non-empty description, a valid
 * invocation policy, a numeric rank, and `candidate.provider === provider.name`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = await import('../lib/v1/index.js');

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A temp home laid out as DSH expects: `<home>/skills/<name>/SKILL.md`.
 *
 * `root` is the *skills* directory itself, which is what assertions reference; `home`
 * is what `DSH_HOME` is set to.
 */
function makeRoot() {
  const home = mkdtempSync(join(tmpdir(), 'skm-roots-'));
  const root = join(home, 'skills');
  mkdirSync(root, { recursive: true });
  return {
    home,
    root,
    skill(name, frontmatter) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), frontmatter);
      return dir;
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Install the host half's provider against a fake context and return the provider object.
 *
 * @param options.dshHome - directory used as `$DSH_HOME` for the scan.
 * @param options.workspaces - workspace registrations the registry returns.
 */
function provider(options) {
  const captured = [];
  const ctx = {
    get: (name) => (name === 'workspaceRegistry' ? { list: () => options.workspaces ?? [] } : undefined),
    inject: (deps, run) => {
      assert.deepEqual(deps, ['skills'], 'host half waits for the skills service');
      run({
        skills: {
          registerProvider: (create) => {
            captured.push(create());
            return () => {};
          },
        },
      });
    },
  };

  const previousHome = process.env.DSH_HOME;
  const previousAgents = process.env.DSH_AGENTS_HOME;
  process.env.DSH_HOME = options.dshHome;
  process.env.DSH_AGENTS_HOME = join(options.dshHome, '..', 'agents-home');
  try {
    HOST.apply(ctx);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    if (previousAgents === undefined) delete process.env.DSH_AGENTS_HOME;
    else process.env.DSH_AGENTS_HOME = previousAgents;
  }

  assert.equal(captured.length, 1, 'exactly one provider is registered');
  return captured[0];
}

test('the host half declares its Loader identity and the skills dependency', () => {
  assert.equal(HOST.name, 'dsh-skill-managers', 'the Loader row resolves this module by name');
  assert.deepEqual(HOST.inject, ['skills']);
  assert.equal(typeof HOST.apply, 'function');
});

test('scans the global root and returns registry-valid candidates', async () => {
  const tree = makeRoot();
  try {
    // A valid directory skill, a dotted reserved child, and a non-directory file.
    tree.skill('caveman', '---\nname: caveman\ndescription: Terse caveman voice.\n---\n\nBody.\n');
    tree.skill('user-only', '---\nname: user-only\ndescription: Hidden from the model.\ndisable-model-invocation: true\n---\n\nBody.\n');
    tree.skill('with-when', '---\nname: with-when\ndescription: Has a when-to-use.\nwhenToUse: Use when testing.\n---\n\nBody.\n');
    mkdirSync(join(tree.root, '.system'), { recursive: true });
    writeFileSync(join(tree.root, 'stray.md'), 'not a skill directory\n');

    const scan = provider({ dshHome: tree.home });
    const result = await scan.list();

    assert.equal(result.complete, true, 'the scan reports completeness');
    const names = result.candidates.map((candidate) => candidate.name).sort();
    assert.deepEqual(names, ['caveman', 'user-only', 'with-when'], 'dotted and flat entries are skipped');

    for (const candidate of result.candidates) {
      assert.match(candidate.name, SKILL_NAME, 'name is kebab-case');
      assert.ok(candidate.description.length > 0, 'description is non-empty');
      assert.equal(candidate.provider, scan.name, 'provider echoes the provider name');
      assert.ok(Number.isFinite(candidate.rank), 'rank is a finite number');
      assert.equal(typeof candidate.source, 'string', 'source is a string');
      assert.equal(typeof candidate.path, 'string', 'path is a string');
      assert.equal(typeof candidate.invocation.modelInvocable, 'boolean', 'modelInvocable is boolean');
      assert.equal(typeof candidate.invocation.userInvocable, 'boolean', 'userInvocable is boolean');
    }

    const userOnly = result.candidates.find((candidate) => candidate.name === 'user-only');
    assert.equal(userOnly.invocation.modelInvocable, false, 'disable-model-invocation is honoured');
    assert.equal(userOnly.invocation.userInvocable, true, 'a model-invisible skill stays user-invocable');

    const withWhen = result.candidates.find((candidate) => candidate.name === 'with-when');
    assert.equal(withWhen.whenToUse, 'Use when testing.', 'whenToUse is carried through');
  } finally {
    tree.cleanup();
  }
});

test('a missing root is empty, not an error', async () => {
  const scan = provider({ dshHome: join(tmpdir(), 'skm-does-not-exist-' + Date.now()) });
  const result = await scan.list();
  assert.deepEqual(result.candidates, []);
  assert.equal(result.complete, true);
});

test('a directory without SKILL.md is skipped', async () => {
  const tree = makeRoot();
  try {
    mkdirSync(join(tree.root, 'not-a-skill'), { recursive: true });
    const scan = provider({ dshHome: tree.home });
    const result = await scan.list();
    assert.deepEqual(result.candidates, []);
  } finally {
    tree.cleanup();
  }
});

test('malformed frontmatter is skipped instead of failing the whole scan', async () => {
  const tree = makeRoot();
  try {
    tree.skill('no-frontmatter', '# just a heading\n');
    tree.skill('no-description', '---\nname: no-description\n---\n\nBody.\n');
    tree.skill('bad-name', '---\nname: Not_Kebab\ndescription: Bad name shape.\n---\n\nBody.\n');
    tree.skill('good', '---\nname: good\ndescription: A valid skill.\n---\n\nBody.\n');

    const scan = provider({ dshHome: tree.home });
    const result = await scan.list();
    assert.deepEqual(result.candidates.map((candidate) => candidate.name), ['good']);
  } finally {
    tree.cleanup();
  }
});

test('project roots are scanned for every registered workspace', async () => {
  const tree = makeRoot();
  const workspaceHome = makeRoot();
  try {
    tree.skill('global-one', '---\nname: global-one\ndescription: A global skill.\n---\n\nBody.\n');
    workspaceHome.skill('project-one', '---\nname: project-one\ndescription: A project skill.\n---\n\nBody.\n');

    // A workspace's project root is `<workspace>/.dsh/skills`, so the tree above must be
    // moved under that spelling.
    const workspacePath = workspaceHome.home;
    mkdirSync(join(workspacePath, '.dsh'), { recursive: true });
    renameSync(workspaceHome.root, join(workspacePath, '.dsh', 'skills'));

    const scan = provider({
      dshHome: tree.home,
      workspaces: [{ id: 'w1', path: workspacePath, title: 'demo' }],
    });
    const result = await scan.list();

    const byName = new Map(result.candidates.map((candidate) => [candidate.name, candidate]));
    assert.deepEqual([...byName.keys()].sort(), ['global-one', 'project-one']);

    assert.equal(byName.get('global-one').source, 'user-dsh', 'the global root reports user-dsh');
    assert.equal(byName.get('global-one').rank, 400, 'the global root keeps rank 400');
    assert.equal(byName.get('project-one').source, 'project-dsh', 'a workspace root reports project-dsh');
    assert.equal(byName.get('project-one').rank, 100, 'a workspace root outranks the global root');
    assert.equal(byName.get('project-one').metadata.workspacePath, workspacePath, 'the workspace is recorded');
  } finally {
    tree.cleanup();
    workspaceHome.cleanup();
  }
});

test('get() returns the instruction body without frontmatter', async () => {
  const tree = makeRoot();
  try {
    tree.skill('caveman', '---\nname: caveman\ndescription: Terse caveman voice.\n---\n\nAnswer first.\n');
    const scan = provider({ dshHome: tree.home });
    const [candidate] = (await scan.list()).candidates;

    const definition = await scan.get(candidate, {});
    assert.equal(definition.content, 'Answer first.\n', 'frontmatter is stripped from the body');
    assert.equal(definition.description, 'Terse caveman voice.', 'the description survives');
  } finally {
    tree.cleanup();
  }
});