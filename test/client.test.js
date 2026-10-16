/**
 * Loads `lib/v1/client.js` the way the DSH browser module table does — by evaluating
 * the file with a `window.__ModuleLoader__.load` stub inside a real jsdom window
 * — then mounts the registered Skills page with real React and drives its states.
 *
 * The Host cannot see a client-half crash until it happens in the page, so this
 * file is the only place the bundle's rendering is checked before install.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'v1', 'client.js'), 'utf8');

/**
 * Create a jsdom window, publish it as the ambient browser globals react-dom
 * reads, and evaluate the bundle against it.
 *
 * @returns the window, the registered factory, and a restore function.
 */
function setup() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true });
  } catch (unavailable) {
    /* A frozen global navigator leaves the component's guarded clipboard read unused. */
  }

  const entries = [];
  win.__ModuleLoader__ = { load: (entry) => entries.push(entry) };
  const requireShim = (specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected require(${specifier})`);
  };
  const run = new win.Function('window', 'document', 'require', source);
  run.call(win, win, win.document, requireShim);

  assert.equal(entries.length, 1, 'the bundle registers exactly one factory');
  assert.equal(entries[0].id, 'dsh-skill-managers');

  return {
    dom,
    win,
    factory: entries[0].factory,
    restore: () => {
      if (previous.window === undefined) delete globalThis.window;
      else globalThis.window = previous.window;
      if (previous.document === undefined) delete globalThis.document;
      else globalThis.document = previous.document;
      if (previous.act === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT;
      else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
    },
  };
}

/** A session store snapshot shaped like the client's `sessions` snapshot. */
function sessionsSnapshot(rows) {
  const byId = {};
  for (const row of rows) byId[row.id] = row;
  return { ids: rows.map((row) => row.id), byId };
}

/** Collect the slot registrations the plugin body performs. */
function mount(client, deps) {
  const registrations = [];
  const ctx = {
    sessions: deps.sessions,
    get: () => undefined,
    remote: deps.skills === undefined ? {} : { skills: deps.skills },
    slots: {
      inject: (key, callback) => {
        registrations.push({ key, entry: callback() });
        return () => {};
      },
      register: (definition, component) => ({ definition, component }),
    },
  };
  client.apply(ctx);
  return registrations;
}

/**
 * The `useWorkspaces` hook the slot owner composes onto the page.
 *
 * Returns a selector hook over a fixed snapshot — the same shape the shipped schedule
 * page reads (`useWorkspaces((snapshot) => snapshot)`).
 */
function useWorkspacesOver(list) {
  const snapshot = {
    items: list.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      path: workspace.path,
      title: workspace.title,
      sessionIds: workspace.sessionIds ?? [],
    })),
    archivedSessionIds: [],
  };
  return (selector) => selector(snapshot);
}

/** The page component the plugin registered under `main`. */
function pageOf(registrations) {
  return registrations.find((row) => row.key === 'main').entry.component;
}

/** Render an element into the jsdom root and settle its effects. */
async function render(element) {
  const container = globalThis.document.getElementById('root');
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

const SKILLS = [
  { name: 'caveman', description: 'Terse caveman voice: answer first, fluff gone.', modelInvocable: true, path: '/w/.dsh/skills/caveman/SKILL.md' },
  { name: 'ponytail', description: 'Forces the laziest solution that actually works.', modelInvocable: true, path: '/w/.dsh/skills/ponytail/SKILL.md' },
  { name: 'ultracave', description: 'Maximum compression.', modelInvocable: false, path: '/w/.dsh/skills/ultracave/SKILL.md' },
];

/** A session face that always reports a retained, open session. */
function openSessions() {
  return {
    binding: () => ({}),
    using: (_target, _options, operation) =>
      Promise.resolve(operation({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } })),
  };
}

test('registers a sidebar entry and a main panel under the same key', () => {
  const { factory, restore } = setup();
  try {
    const client = factory(() => React);
    const registrations = mount(client, {});

    const panel = registrations.find((row) => row.key === 'main');
    const entry = registrations.find((row) => row.key === 'sidebar.panellist');

    assert.ok(panel, 'registers a main panel');
    assert.equal(panel.entry.definition.key, 'skills');
    assert.ok(entry, 'registers a sidebar panel-list entry');
    assert.equal(entry.entry.definition.id, 'skills');
    assert.equal(entry.entry.definition.label(), 'Skills');
    // Plugins draws at 0 and Automation tasks at 10; Skills sits between them.
    assert.ok(entry.entry.definition.order > 0 && entry.entry.definition.order < 10, 'draws between Plugins and Automation tasks');
    assert.equal(typeof panel.entry.definition.inject, 'function', 'the panel receives its services through inject');
  } finally {
    restore();
  }
});

test('declares the services it reads', () => {
  const { factory, restore } = setup();
  try {
    const client = factory(() => React);
    for (const key of ['slots', 'sessions', 'remote', 'remote.skills']) {
      assert.ok(client.inject.includes(key), `injects ${key}`);
    }
  } finally {
    restore();
  }
});

test('lists the catalog the active session can see', async () => {
  const { factory, restore } = setup();
  try {
    const asked = [];
    const skills = {
      list: (request) => {
        asked.push(request.sessionId);
        return Promise.resolve({ ok: true, value: { skills: SKILLS } });
      },
    };
    const sessions = openSessions();
    const client = factory(() => React);
    const useSessions = () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 }, updatedAt: 2 }]);

    const registrations = mount(client, { sessions, skills });
    const container = await render(React.createElement(pageOf(registrations), { useSessions, useWorkspaces: useWorkspacesOver([]), skmDeps: { sessions, skills } }));

    assert.deepEqual(asked, ['s1'], 'asks for the session the main view retains');
    const text = container.textContent;
    assert.match(text, /3 skills/);
    assert.match(text, /\/caveman/);
    assert.match(text, /\/ponytail/);
    assert.match(text, /user only/, 'a model-invisible skill is badged');
    assert.match(text, /~\/\.dsh\/skills/, 'the page explains where DSH looks');
    // The path is collapsed behind a toggle, so assert on the toggle instead.
    assert.match(text, /show path/);
  } finally {
    restore();
  }
});

test('offers All, Global and Workspaces instead of a session picker', async () => {
  const { factory, restore } = setup();
  try {
    const skills = { list: () => Promise.resolve({ ok: true, value: { skills: SKILLS } }) };
    const sessions = openSessions();
    const workspaces = [{ workspaceId: 'w1', path: '/w', title: 'default-workspace' }];
    const client = factory(() => React);
    const useSessions = () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]);

    const registrations = mount(client, { sessions, skills, workspaces });
    const container = await render(
      React.createElement(pageOf(registrations), { useSessions, useWorkspaces: useWorkspacesOver([]), skmDeps: { sessions, skills } })
    );

    const tabs = [...container.querySelectorAll('.skm-tab')].map((node) => node.textContent.replace(/\d+$/, ''));
    assert.deepEqual(tabs, ['All', 'Global', 'Workspaces']);
    assert.ok(container.querySelector('.skm-sel') === null, 'no session dropdown remains');
  } finally {
    restore();
  }
});

test('Global shows only skills outside the workspace roots', async () => {
  const { factory, restore } = setup();
  try {
    const mixed = [
      { name: 'in-workspace', description: 'project copy', modelInvocable: true, path: '/w/.dsh/skills/in-workspace/SKILL.md' },
      { name: 'everywhere', description: 'user copy', modelInvocable: true, path: '/Users/me/.dsh/skills/everywhere/SKILL.md' },
    ];
    const skills = { list: () => Promise.resolve({ ok: true, value: { skills: mixed } }) };
    const sessions = openSessions();
    const workspaces = [{ workspaceId: 'w1', path: '/w', title: 'default-workspace' }];
    const client = factory(() => React);
    const useSessions = () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]);

    const registrations = mount(client, { sessions, skills, workspaces });
    const container = await render(
      React.createElement(pageOf(registrations), { useSessions, useWorkspaces: useWorkspacesOver(workspaces), skmDeps: { sessions, skills } })
    );

    const globalTab = [...container.querySelectorAll('.skm-tab')].find((node) => node.textContent.startsWith('Global'));
    await act(async () => {
      Simulate.click(globalTab);
    });

    assert.match(container.textContent, /\/everywhere/);
    assert.doesNotMatch(container.textContent, /\/in-workspace/);
  } finally {
    restore();
  }
});

test('search narrows the list to name and description matches', async () => {
  const { factory, restore } = setup();
  try {
    const skills = { list: () => Promise.resolve({ ok: true, value: { skills: SKILLS } }) };
    const sessions = openSessions();
    const client = factory(() => React);
    const useSessions = () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]);

    const registrations = mount(client, { sessions, skills });
    const container = await render(React.createElement(pageOf(registrations), { useSessions, useWorkspaces: useWorkspacesOver([]), skmDeps: { sessions, skills } }));

    const input = container.querySelector('.skm-input');
    assert.ok(input !== null, 'a search box rendered');
    // `Simulate` invokes the registered onChange handler directly. Dispatching a
    // synthetic `input` Event does not reach React 18's change plugin under this
    // Node+jsdom combination (unlike `click`, which does), and a real browser
    // fires trusted input events that React handles normally.
    await act(async () => {
      Simulate.change(input, { target: { value: 'laziest' } });
    });
    // Wait for 300ms search debounce, then flush React
    await new Promise(r => setTimeout(r, 400));
    await act(async () => {});

    assert.match(container.textContent, /\/ponytail/);
    assert.doesNotMatch(container.textContent, /\/caveman/);
  } finally {
    restore();
  }
});

test('falls back to the newest ordinary session when none is retained', async () => {
  const { factory, restore } = setup();
  try {
    const asked = [];
    const skills = { list: (request) => { asked.push(request.sessionId); return Promise.resolve({ ok: true, value: { skills: [] } }); } };
    const sessions = openSessions();
    const client = factory(() => React);
    const useSessions = () =>
      sessionsSnapshot([
        { id: 'sub', origin: 'subagent', updatedAt: 99 },
        { id: 'blank', blank: true, updatedAt: 98 },
        { id: 'old', updatedAt: 1 },
        { id: 'newest', updatedAt: 50 },
      ]);

    const registrations = mount(client, { sessions, skills });
    const container = await render(React.createElement(pageOf(registrations), { useSessions, useWorkspaces: useWorkspacesOver([]), skmDeps: { sessions, skills } }));

    assert.deepEqual(asked, ['newest']);
    assert.match(container.textContent, /No skills found/);
  } finally {
    restore();
  }
});

test('explains itself when no session is available', async () => {
  const { factory, restore } = setup();
  try {
    const client = factory(() => React);
    const registrations = mount(client, {});
    const container = await render(
      React.createElement(pageOf(registrations), { useSessions: () => sessionsSnapshot([]), skmDeps: {} })
    );

    assert.match(container.textContent, /No session available/);
    assert.match(container.textContent, /Where DSH looks for skills/);
  } finally {
    restore();
  }
});

test('surfaces a catalog failure instead of crashing', async () => {
  const { factory, restore } = setup();
  try {
    const skills = { list: () => Promise.resolve({ ok: false, error: { code: 'no-registry', message: 'no skill registry can serve this session' } }) };
    const sessions = openSessions();
    const client = factory(() => React);
    const registrations = mount(client, { sessions, skills });
    const container = await render(
      React.createElement(pageOf(registrations), {
        useSessions: () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]),
        useWorkspaces: useWorkspacesOver([]),
        skmDeps: { sessions, skills },
      })
    );

    assert.match(container.textContent, /skills\/list failed: no-registry/);
  } finally {
    restore();
  }
});

test('survives a missing Remote without throwing', async () => {
  const { factory, restore } = setup();
  try {
    const client = factory(() => React);
    const registrations = mount(client, {});
    const container = await render(
      React.createElement(pageOf(registrations), {
        useSessions: () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]),
        skmDeps: {},
      })
    );

    assert.match(container.textContent, /the skills Remote is not mounted/);
  } finally {
    restore();
  }
});

test('survives a context that throws on undeclared property reads', async () => {
  const { factory, restore } = setup();
  try {
    const skills = { list: () => Promise.resolve({ ok: true, value: { skills: SKILLS } }) };
    const sessions = openSessions();
    const client = factory(() => React);

    // The real client context throws when an *undeclared* service is read as a property
    // (`cannot get property "workspaces"`). `workspaces` is not in this plugin's inject
    // list, so apply() must reach it through ctx.get only.
    const registrations = [];
    const ctx = {
      sessions,
      remote: { skills },
      get: (name) => {
        if (name === 'workspaces') return undefined;
        throw new Error('cannot get property "' + name + '"');
      },
      slots: {
        inject: (key, callback) => {
          registrations.push({ key, entry: callback() });
          return () => {};
        },
        register: (definition, component) => ({ definition, component }),
      },
    };
    Object.defineProperty(ctx, 'workspaces', {
      get() { throw new Error('cannot get property "workspaces"'); },
    });

    client.apply(ctx);

    const useSessions = () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]);
    const container = await render(
      React.createElement(pageOf(registrations), { useSessions, useWorkspaces: useWorkspacesOver([]), skmDeps: { sessions, skills } })
    );

    assert.match(container.textContent, /\/caveman/, 'the page still renders without a workspaces service');
  } finally {
    restore();
  }
});

test('groups the catalog by origin, with a neutral label for pathless skills', async () => {
  const { factory, restore } = setup();
  try {
    const mixed = [
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
    const skills = { list: () => Promise.resolve({ ok: true, value: { skills: mixed } }) };
    const sessions = openSessions();
    const workspaces = [{ workspaceId: 'w1', path: '/w', title: 'default-workspace' }];
    const client = factory(() => React);
    const registrations = mount(client, { sessions, skills, workspaces });
    const container = await render(
      React.createElement(pageOf(registrations), {
        useSessions: () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 }, cwd: '/w' }]),
        useWorkspaces: useWorkspacesOver(workspaces),
        skmDeps: { sessions, skills },
      })
    );

    const buckets = [...container.querySelectorAll('.skm-group')].map((section) => ({
      title: section.querySelector('.skm-grouptitle').textContent,
      skills: [...section.querySelectorAll('.skm-name')].map((node) => node.textContent),
    }));

    assert.deepEqual(buckets, [
      { title: 'Workspace \u00b7 default-workspace', skills: ['/caveman'] },
      { title: 'Global', skills: ['/megacave', '/shared-one'] },
      { title: 'Bundled', skills: ['/agent-experience', '/office-docx', '/mystery'] },
    ]);
    assert.match(container.textContent, /6 skills/);
    assert.match(container.textContent, /1 in a workspace/);
  } finally {
    restore();
  }
});

test('Workspaces lists every registered workspace, including one with no skills', async () => {
  const { factory, restore } = setup();
  try {
    const skills = {
      list: () =>
        Promise.resolve({
          ok: true,
          value: { skills: [{ name: 'only-here', description: 'a project skill', modelInvocable: true, path: '/w/.dsh/skills/only-here/SKILL.md' }] },
        }),
    };
    const sessions = openSessions();
    const workspaces = [
      { workspaceId: 'w1', path: '/w', title: 'default-workspace' },
      { workspaceId: 'w2', path: '/empty', title: 'second-workspace' },
    ];
    const client = factory(() => React);
    const registrations = mount(client, { sessions, skills, workspaces });
    const container = await render(
      React.createElement(pageOf(registrations), {
        useSessions: () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 } }]),
        useWorkspaces: useWorkspacesOver(workspaces),
        skmDeps: { sessions, skills },
      })
    );

    const wsTab = [...container.querySelectorAll('.skm-tab')].find((node) => node.textContent.startsWith('Workspaces'));
    await act(async () => {
      Simulate.click(wsTab);
    });

    // Both registered workspaces appear, and the empty one is shown as 0 rather than hidden.
    assert.match(container.textContent, /default-workspace/);
    assert.match(container.textContent, /second-workspace/);
    assert.match(container.textContent, /\/only-here/);
    const counts = [...container.querySelectorAll('.skm-group')].map((section) => ({
      title: section.querySelector('.skm-grouptitle').textContent,
      count: section.querySelector('.skm-groupcount').textContent,
    }));
    assert.deepEqual(counts, [
      { title: 'Workspace \u00b7 default-workspace', count: '1' },
      { title: 'Workspace \u00b7 second-workspace', count: '0' },
    ]);
  } finally {
    restore();
  }
});

test('attributes a workspace by its registered path, not by path shape', async () => {
  const { factory, restore } = setup();
  try {
    // A project root shape that belongs to a *different* workspace must not be
    // labelled as this one's.
    const skills = {
      list: () =>
        Promise.resolve({
          ok: true,
          value: { skills: [{ name: 'other', description: 'another project', modelInvocable: true, path: '/elsewhere/.dsh/skills/other/SKILL.md' }] },
        }),
    };
    const sessions = openSessions();
    const workspaces = [{ workspaceId: 'w1', path: '/w', title: 'default-workspace' }];
    const client = factory(() => React);
    const registrations = mount(client, { sessions, skills, workspaces });
    const container = await render(
      React.createElement(pageOf(registrations), {
        useSessions: () => sessionsSnapshot([{ id: 's1', retainedBy: { mainView: 1 }, cwd: '/w' }]),
        useWorkspaces: useWorkspacesOver(workspaces),
        skmDeps: { sessions, skills },
      })
    );

    const titles = [...container.querySelectorAll('.skm-grouptitle')].map((node) => node.textContent);
    assert.deepEqual(titles, ['Global']);
    assert.doesNotMatch(container.textContent, /default-workspace/);
  } finally {
    restore();
  }
});
