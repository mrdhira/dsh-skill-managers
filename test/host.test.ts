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
 *
 * The imported module is the **built** artifact, not `src/**`: the suite has to validate
 * the bytes that ship (see `build.test.ts` for the freshness gate that makes that true).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = await import('../lib/v1/index.js');

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One skill candidate, as the provider yields it. Observed from the registry contract. */
interface Candidate {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean };
  readonly source: string;
  readonly provider: string;
  readonly rank: number;
  readonly path: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** A resolved skill definition, as `provider.get()` returns it. */
interface SkillDefinition {
  readonly content: string;
  readonly description: string;
}

/** The provider the host half registers, limited to what these tests exercise. */
interface Provider {
  readonly name: string;
  list(): Promise<{ candidates: Candidate[]; complete: boolean }>;
  get(candidate: Candidate, options: { signal?: AbortSignal }): Promise<SkillDefinition>;
}

/** A workspace registration, as `workspaceRegistry.list()` returns it. */
interface WorkspaceRegistration {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}

/** The temp tree a test scans, plus the helpers that populate it. */
interface TempRoot {
  readonly home: string;
  readonly root: string;
  skill(name: string, frontmatter: string): string;
  cleanup(): void;
}

/** Options accepted by {@link provider}. */
interface ProviderOptions {
  readonly dshHome: string;
  readonly workspaces?: readonly WorkspaceRegistration[];
}

/**
 * A temp home laid out as DSH expects: `<home>/skills/<name>/SKILL.md`.
 *
 * `root` is the *skills* directory itself, which is what assertions reference; `home`
 * is what `DSH_HOME` is set to.
 */
function makeRoot(): TempRoot {
  const home = mkdtempSync(join(tmpdir(), 'skm-roots-'));
  const root = join(home, 'skills');
  mkdirSync(root, { recursive: true });
  return {
    home,
    root,
    skill(name: string, frontmatter: string): string {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), frontmatter);
      return dir;
    },
    cleanup(): void {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * Install the host half's provider against a fake context and return the provider object.
 *
 * @param options - `dshHome` is the directory used as `$DSH_HOME` for the scan;
 *   `workspaces` are the registrations the registry returns.
 * @returns the single provider the host half registered.
 */
function provider(options: ProviderOptions): Provider {
  const captured: Provider[] = [];
  const ctx = {
    get: (name: string): unknown =>
      name === 'workspaceRegistry' ? { list: () => options.workspaces ?? [] } : undefined,
    inject: (deps: readonly string[], run: (child: unknown) => void): void => {
      assert.deepEqual(deps, ['skills'], 'host half waits for the skills service');
      run({
        skills: {
          registerProvider: (create: () => Provider): (() => void) => {
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
    assert.ok(userOnly !== undefined, 'the model-invisible skill was found');
    assert.equal(userOnly.invocation.modelInvocable, false, 'disable-model-invocation is honoured');
    assert.equal(userOnly.invocation.userInvocable, true, 'a model-invisible skill stays user-invocable');

    const withWhen = result.candidates.find((candidate) => candidate.name === 'with-when');
    assert.ok(withWhen !== undefined, 'the when-to-use skill was found');
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

    const globalOne = byName.get('global-one');
    const projectOne = byName.get('project-one');
    assert.ok(globalOne !== undefined && projectOne !== undefined, 'both roots were scanned');
    assert.equal(globalOne.source, 'user-dsh', 'the global root reports user-dsh');
    assert.equal(globalOne.rank, 400, 'the global root keeps rank 400');
    assert.equal(projectOne.source, 'project-dsh', 'a workspace root reports project-dsh');
    assert.equal(projectOne.rank, 100, 'a workspace root outranks the global root');
    assert.equal(projectOne.metadata?.workspacePath, workspacePath, 'the workspace is recorded');
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
    assert.ok(candidate !== undefined, 'the scan found the one skill');

    const definition = await scan.get(candidate, {});
    assert.equal(definition.content, 'Answer first.\n', 'frontmatter is stripped from the body');
    assert.equal(definition.description, 'Terse caveman voice.', 'the description survives');
  } finally {
    tree.cleanup();
  }
});