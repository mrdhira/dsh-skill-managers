/**
 * Client-half coverage under jsdom, for `src/client/index.cts` → `lib/v1/client.js`.
 *
 * The bundle is a plain-JS `window.__ModuleLoader__.load({...})` script, so the harness
 * evaluates the real file through a stub loader rather than importing it — the same path
 * the browser takes. The Host cannot see a client-half crash until it happens in the page,
 * so this file is the only place the bundle's rendering is checked before install.
 *
 * The file under test is the **built** artifact; `build.test.ts` gates its freshness.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadBundle,
  mount,
  openSessions,
  renderPage,
  sessionsSnapshot,
  settle,
  useWorkspacesOver,
  type Registration,
  type SkillRow,
  type SkillsRemote,
} from './harness.ts';

const SKILLS: readonly SkillRow[] = [
  { name: 'caveman', description: 'Terse caveman voice: answer first, fluff gone.', modelInvocable: true, path: '/w/.dsh/skills/caveman/SKILL.md' },
  { name: 'ponytail', description: 'Forces the laziest solution that actually works.', modelInvocable: true, path: '/w/.dsh/skills/ponytail/SKILL.md' },
  { name: 'ultracave', description: 'Maximum compression.', modelInvocable: false, path: '/w/.dsh/skills/ultracave/SKILL.md' },
];

/** A `skills` Remote that always succeeds with the given rows, recording the session asked. */
function skillsReturning(rows: readonly SkillRow[], asked: string[] = []): SkillsRemote {
  return {
    list: (request) => {
      asked.push(request.sessionId);
      return Promise.resolve({ ok: true, value: { skills: rows } });
    },
  };
}

/** The registrations a fresh mount produced. */
function freshRegistrations(): Registration[] {
  const bundle = loadBundle();
  assert.equal(bundle.plugin.name, 'dsh-skill-managers', 'the bundle names the package');
  return bundle.registrations;
}

test('registers a sidebar entry and a main panel under the same key', () => {
  const registrations = freshRegistrations();
  mount(registrations, {});

  const panel = registrations.find((row) => row.key === 'main');
  const entry = registrations.find((row) => row.key === 'sidebar.panellist');

  assert.ok(panel !== undefined, 'registers a main panel');
  assert.equal(panel.entry.definition.key, 'skills');
  assert.ok(entry !== undefined, 'registers a sidebar panel-list entry');
  assert.equal(entry.entry.definition.id, 'skills');
  const label = entry.entry.definition.label;
  assert.equal(typeof label === 'function' ? label() : label, 'Skills');
  // Plugins draws at 0 and Automation tasks at 10; Skills sits between them.
  assert.ok(
    (entry.entry.definition.order ?? 0) > 0 && (entry.entry.definition.order ?? 0) < 10,
    'draws between Plugins and Automation tasks'
  );
  assert.equal(typeof panel.entry.definition.inject, 'function', 'the panel receives its services through inject');
});

test('declares the services it reads', () => {
  const bundle = loadBundle();
  for (const key of ['slots', 'sessions', 'remote', 'remote.skills']) {
    assert.ok(bundle.plugin.inject.includes(key), `injects ${key}`);
  }
});

test('lists the catalog the active session can see', async () => {
  const asked: string[] = [];
  const skills = skillsReturning(SKILLS, asked);
  const sessions = openSessions();
  const registrations = mount(freshRegistrations(), { sessions, skills });
  const useSessions = () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 }, updatedAt: 2 }]);

  const view = await renderPage(registrations, { useSessions, useWorkspaces: useWorkspacesOver([]), skmDeps: { sessions, skills } });

  assert.deepEqual(asked, ['s1'], 'asks for the session the main view retains');
  const text = view.text();
  assert.match(text, /3 skills/);
  assert.match(text, /\/caveman/);
  assert.match(text, /\/ponytail/);
  assert.match(text, /user only/, 'a model-invisible skill is badged');
  assert.match(text, /~\/\.dsh\/skills/, 'the page explains where DSH looks');
  // The path is collapsed behind a toggle, so assert on the toggle instead.
  assert.match(text, /show path/);
  view.unmount();
});

test('offers All, Global and Workspaces instead of a session picker', async () => {
  const skills = skillsReturning(SKILLS);
  const sessions = openSessions();
  const registrations = mount(freshRegistrations(), { sessions, skills });
  const useSessions = () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]);

  const view = await renderPage(registrations, { useSessions, useWorkspaces: useWorkspacesOver([]), skmDeps: { sessions, skills } });

  const tabs = [...view.container.querySelectorAll('.skm-tab')].map((node) => (node.textContent ?? '').replace(/\d+$/, ''));
  assert.deepEqual(tabs, ['All', 'Global', 'Workspaces']);
  assert.ok(view.container.querySelector('.skm-sel') === null, 'no session dropdown remains');
  view.unmount();
});

test('Global shows only skills outside the workspace roots', async () => {
  const mixed: readonly SkillRow[] = [
    { name: 'in-workspace', description: 'project copy', modelInvocable: true, path: '/w/.dsh/skills/in-workspace/SKILL.md' },
    { name: 'everywhere', description: 'user copy', modelInvocable: true, path: '/Users/me/.dsh/skills/everywhere/SKILL.md' },
  ];
  const skills = skillsReturning(mixed);
  const sessions = openSessions();
  const workspaces = [{ workspaceId: 'w1', path: '/w', title: 'default-workspace' }];
  const registrations = mount(freshRegistrations(), { sessions, skills, workspaces });
  const useSessions = () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]);

  const view = await renderPage(registrations, {
    useSessions,
    useWorkspaces: useWorkspacesOver(workspaces),
    skmDeps: { sessions, skills },
  });

  const globalTab = [...view.container.querySelectorAll('.skm-tab')].find((node) => (node.textContent ?? '').startsWith('Global'));
  assert.ok(globalTab !== undefined, 'the Global tab rendered');
  await view.clickNode(globalTab);

  assert.match(view.text(), /\/everywhere/);
  assert.doesNotMatch(view.text(), /\/in-workspace/);
  view.unmount();
});

test('search narrows the list to name and description matches', async () => {
  const skills = skillsReturning(SKILLS);
  const sessions = openSessions();
  const registrations = mount(freshRegistrations(), { sessions, skills });
  const useSessions = () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]);

  const view = await renderPage(registrations, { useSessions, useWorkspaces: useWorkspacesOver([]), skmDeps: { sessions, skills } });

  assert.ok(view.container.querySelector('.skm-input') !== null, 'a search box rendered');
  await view.type('.skm-input', 'laziest');
  await settle(400);

  assert.match(view.text(), /\/ponytail/);
  assert.doesNotMatch(view.text(), /\/caveman/);
  view.unmount();
});

test('falls back to the newest ordinary session when none is retained', async () => {
  const asked: string[] = [];
  const skills = skillsReturning([], asked);
  const sessions = openSessions();
  const registrations = mount(freshRegistrations(), { sessions, skills });
  const useSessions = () =>
    sessionsSnapshot([
      { id: 'sub', origin: 'subagent', updatedAt: 99 },
      { id: 'blank', blank: true, updatedAt: 98 },
      { id: 'old', updatedAt: 1 },
      { id: 'newest', updatedAt: 50 },
    ]);

  const view = await renderPage(registrations, { useSessions, useWorkspaces: useWorkspacesOver([]), skmDeps: { sessions, skills } });

  assert.deepEqual(asked, ['newest']);
  assert.match(view.text(), /No skills found/);
  view.unmount();
});

test('explains itself when no session is available', async () => {
  const registrations = mount(freshRegistrations(), {});
  const view = await renderPage(registrations, { useSessions: () => sessionsSnapshot([]), skmDeps: {} });

  assert.match(view.text(), /No session available/);
  assert.match(view.text(), /Where DSH looks for skills/);
  view.unmount();
});

test('surfaces a catalog failure instead of crashing', async () => {
  const skills: SkillsRemote = {
    list: () => Promise.resolve({ ok: false, error: { code: 'no-registry', message: 'no skill registry can serve this session' } }),
  };
  const sessions = openSessions();
  const registrations = mount(freshRegistrations(), { sessions, skills });
  const view = await renderPage(registrations, {
    useSessions: () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]),
    useWorkspaces: useWorkspacesOver([]),
    skmDeps: { sessions, skills },
  });

  assert.match(view.text(), /skills\/list failed: no-registry/);
  view.unmount();
});

test('survives a missing Remote without throwing', async () => {
  const registrations = mount(freshRegistrations(), {});
  const view = await renderPage(registrations, {
    useSessions: () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]),
    skmDeps: {},
  });

  assert.match(view.text(), /the skills Remote is not mounted/);
  view.unmount();
});

test('survives a context that throws on undeclared property reads', async () => {
  const skills = skillsReturning(SKILLS);
  const sessions = openSessions();

  // The real client context throws when an *undeclared* service is read as a property
  // (`cannot get property "workspaces"`). `workspaces` is not in this plugin's inject
  // list, so apply() must reach it through ctx.get only.
  const registrations: Registration[] = [];
  const ctx: Record<string, unknown> = {
    sessions,
    remote: { skills },
    get: (name: string) => {
      if (name === 'workspaces') return undefined;
      throw new Error('cannot get property "' + name + '"');
    },
    slots: {
      inject: (key: string, callback: () => unknown) => {
        registrations.push({ key, entry: callback() as Registration['entry'] });
        return () => {};
      },
      register: (definition: unknown, component: unknown) => ({ definition, component }),
    },
  };
  Object.defineProperty(ctx, 'workspaces', {
    get() {
      throw new Error('cannot get property "workspaces"');
    },
  });

  loadBundle().plugin.apply(ctx);

  const useSessions = () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]);
  const view = await renderPage(registrations, { useSessions, useWorkspaces: useWorkspacesOver([]), skmDeps: { sessions, skills } });

  assert.match(view.text(), /\/caveman/, 'the page still renders without a workspaces service');
  view.unmount();
});

test('groups the catalog by origin, with a neutral label for pathless skills', async () => {
  const mixed: readonly SkillRow[] = [
    { name: 'caveman', description: 'workspace copy', modelInvocable: true, path: '/w/.dsh/skills/caveman/SKILL.md' },
    { name: 'megacave', description: 'user copy', modelInvocable: false, path: '/Users/me/.dsh/skills/megacave/SKILL.md' },
    { name: 'shared-one', description: 'shared copy', modelInvocable: true, path: '/Users/me/.agents/skills/shared-one/SKILL.md' },
    {
      name: 'agent-experience',
      description: 'preset copy',
      modelInvocable: true,
      path: '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/agent-experience/SKILL.md',
    },
    { name: 'office-docx', description: 'shipped office', modelInvocable: true, path: '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/office-skills/office-docx/SKILL.md' },
    { name: 'mystery', description: 'no path at all', modelInvocable: true },
  ];
  const skills = skillsReturning(mixed);
  const sessions = openSessions();
  const workspaces = [{ workspaceId: 'w1', path: '/w', title: 'default-workspace' }];
  const registrations = mount(freshRegistrations(), { sessions, skills, workspaces });
  const view = await renderPage(registrations, {
    useSessions: () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 }, cwd: '/w' }]),
    useWorkspaces: useWorkspacesOver(workspaces),
    skmDeps: { sessions, skills },
  });

  const buckets = [...view.container.querySelectorAll('.skm-group')].map((section) => ({
    title: section.querySelector('.skm-grouptitle')?.textContent,
    skills: [...section.querySelectorAll('.skm-name')].map((node) => node.textContent),
  }));

  assert.deepEqual(buckets, [
    { title: 'Workspace \u00b7 default-workspace', skills: ['/caveman'] },
    { title: 'Global', skills: ['/megacave', '/shared-one'] },
    { title: 'Bundled', skills: ['/agent-experience', '/office-docx', '/mystery'] },
  ]);
  assert.match(view.text(), /6 skills/);
  assert.match(view.text(), /1 in a workspace/);
  view.unmount();
});

test('Workspaces lists every registered workspace, including one with no skills', async () => {
  const skills = skillsReturning([{ name: 'only-here', description: 'a project skill', modelInvocable: true, path: '/w/.dsh/skills/only-here/SKILL.md' }]);
  const sessions = openSessions();
  const workspaces = [
    { workspaceId: 'w1', path: '/w', title: 'default-workspace' },
    { workspaceId: 'w2', path: '/empty', title: 'second-workspace' },
  ];
  const registrations = mount(freshRegistrations(), { sessions, skills, workspaces });
  const view = await renderPage(registrations, {
    useSessions: () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]),
    useWorkspaces: useWorkspacesOver(workspaces),
    skmDeps: { sessions, skills },
  });

  const wsTab = [...view.container.querySelectorAll('.skm-tab')].find((node) => (node.textContent ?? '').startsWith('Workspaces'));
  assert.ok(wsTab !== undefined, 'the Workspaces tab rendered');
  await view.clickNode(wsTab);

  // Both registered workspaces appear, and the empty one is shown as 0 rather than hidden.
  assert.match(view.text(), /default-workspace/);
  assert.match(view.text(), /second-workspace/);
  assert.match(view.text(), /\/only-here/);
  const counts = [...view.container.querySelectorAll('.skm-group')].map((section) => ({
    title: section.querySelector('.skm-grouptitle')?.textContent,
    count: section.querySelector('.skm-groupcount')?.textContent,
  }));
  assert.deepEqual(counts, [
    { title: 'Workspace \u00b7 default-workspace', count: '1' },
    { title: 'Workspace \u00b7 second-workspace', count: '0' },
  ]);
  view.unmount();
});

test('attributes a workspace by its registered path, not by path shape', async () => {
  // A project root shape that belongs to a *different* workspace must not be
  // labelled as this one's.
  const skills = skillsReturning([{ name: 'other', description: 'another project', modelInvocable: true, path: '/elsewhere/.dsh/skills/other/SKILL.md' }]);
  const sessions = openSessions();
  const workspaces = [{ workspaceId: 'w1', path: '/w', title: 'default-workspace' }];
  const registrations = mount(freshRegistrations(), { sessions, skills, workspaces });
  const view = await renderPage(registrations, {
    useSessions: () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 }, cwd: '/w' }]),
    useWorkspaces: useWorkspacesOver(workspaces),
    skmDeps: { sessions, skills },
  });

  const titles = [...view.container.querySelectorAll('.skm-grouptitle')].map((node) => node.textContent);
  assert.deepEqual(titles, ['Global']);
  assert.doesNotMatch(view.text(), /default-workspace/);
  view.unmount();
});