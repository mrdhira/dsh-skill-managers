/**
 * Shared jsdom harness for the client bundle.
 *
 * The bundle is a plain-JS `window.__ModuleLoader__.load({...})` script, so it is
 * evaluated through a stub loader — the same path the browser takes — rather than
 * imported. One realm is created and reused: a realm per test is megabytes of native
 * state, and the bundle is realm-scoped anyway. Each mount gets its own container.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { act, Simulate } from 'react-dom/test-utils';

declare global {
  /** React's `act()` opt-in flag; @types/react 18 does not declare it. */
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = readFileSync(fileURLToPath(new URL('../lib/v1/client.js', import.meta.url)), 'utf8');

/** What the bundle registered for one slot. */
export interface Registration {
  readonly key: string;
  readonly entry: {
    readonly definition: {
      readonly key?: string;
      readonly id?: string;
      readonly label?: (() => string) | string;
      readonly order?: number;
      readonly inject?: unknown;
      readonly [field: string]: unknown;
    };
    readonly component: React.ComponentType<Record<string, unknown>>;
    readonly [field: string]: unknown;
  };
}

/** The plugin object the bundle's factory returned. */
export interface ClientPlugin {
  readonly name: string;
  readonly inject: string[];
  apply(ctx: unknown): unknown;
}

/** The evaluated bundle: the realm it ran in and the registrations it made. */
export interface LoadedBundle {
  readonly dom: JSDOM;
  readonly plugin: ClientPlugin;
  readonly registrations: Registration[];
}

/** The `skills` Remote this plugin calls. */
export interface SkillsRemote {
  list(request: { sessionId: string }): Promise<
    { ok: true; value: { skills: readonly SkillRow[] } } | { ok: false; error: { code: string; message: string } }
  >;
}

/** One skill row, as the wire carries it. */
export interface SkillRow {
  readonly name: string;
  readonly description: string;
  readonly modelInvocable: boolean;
  readonly path?: string;
}

/** A workspace row, as the `useWorkspaces` snapshot carries it. */
export interface WorkspaceRow {
  readonly workspaceId: string;
  readonly path: string;
  readonly title: string;
  readonly sessionIds?: readonly string[];
}

/** Handles for one mounted tree. */
export interface MountedView {
  readonly container: HTMLElement;
  text(): string;
  /** Click the first element matching a selector. */
  click(selector: string): Promise<void>;
  /** Click an already-resolved node. */
  clickNode(node: Element | null | undefined): Promise<void>;
  /** Type into the first element matching a selector, as a user change event. */
  type(selector: string, value: string): Promise<void>;
  unmount(): void;
}

/** One realm, evaluated once. */
let shared: LoadedBundle | null = null;

/**
 * Evaluate the bundle once against a shared DOM.
 *
 * React renders in this realm while the component is defined in the VM realm, so the DOM
 * globals must exist on both sides.
 *
 * @returns the DOM, the plugin and every registration the bundle made.
 */
export function loadBundle(): LoadedBundle {
  if (shared !== null) return shared;
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/',
  });
  const realm = dom.window as unknown as Window & typeof globalThis;
  globalThis.window = realm;
  globalThis.document = realm.document;

  const registrations: Registration[] = [];
  let plugin: ClientPlugin | null = null;

  const sandbox: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    Intl,
    Date,
    Math,
    JSON,
    Promise,
    console,
    setTimeout: dom.window.setTimeout.bind(dom.window),
    clearTimeout: dom.window.clearTimeout.bind(dom.window),
    // The bundle aborts its in-flight catalog read when the session changes, so the
    // factories it constructs must exist inside this realm too. The original harness
    // evaluated through `win.Function` and inherited them from jsdom's window; an
    // explicit sandbox has to name them.
    AbortController: dom.window.AbortController,
    AbortSignal: dom.window.AbortSignal,
    URL: dom.window.URL,
  };
  sandbox.globalThis = sandbox;
  (dom.window as unknown as { __ModuleLoader__: unknown }).__ModuleLoader__ = {
    load({ id, factory }: { id: string; factory: (require: (specifier: string) => unknown) => ClientPlugin }) {
      assert.equal(id, 'dsh-skill-managers', 'the bundle id must equal the package name');
      plugin = factory((specifier: string) => {
        if (specifier === 'react') return React;
        if (specifier === 'react-dom') return ReactDOM;
        throw new Error(`unexpected require("${specifier}")`);
      });
    },
  };

  runInContext(SOURCE, createContext(sandbox));
  assert.ok(plugin !== null, 'the bundle should have registered its factory');

  shared = { dom, plugin, registrations };
  return shared;
}

/**
 * Apply the plugin to a fake client context and collect its registrations.
 *
 * The context mirrors the real restricted one: a service named in the plugin's inject
 * list is a readable property, any other property read throws, and `ctx.get(name)` is
 * always safe — the two paths the client half actually takes.
 *
 * @param managed - the registrations sink; cleared before the plugin runs.
 * @param deps - the services to offer.
 * @returns the registrations the plugin made, in order.
 */
export function mount(
  managed: Registration[],
  deps: { sessions?: unknown; skills?: SkillsRemote; workspaces?: unknown } = {}
): Registration[] {
  managed.length = 0;
  const ctx: Record<string, unknown> = {
    sessions: deps.sessions,
    get: (name: string): unknown => {
      if (name === 'workspaces') return deps.workspaces;
      return undefined;
    },
    remote: deps.skills === undefined ? {} : { skills: deps.skills },
    slots: {
      inject: (key: string, callback: () => unknown): (() => void) => {
        managed.push({ key, entry: callback() as Registration['entry'] });
        return () => {};
      },
      register: (definition: unknown, component: unknown): { definition: unknown; component: unknown } => ({
        definition,
        component,
      }),
    },
  };
  const plugin = loadBundle().plugin;
  plugin.apply(ctx);
  return managed;
}

/**
 * The `useWorkspaces` hook the slot owner composes onto the page.
 *
 * Returns a selector hook over a fixed snapshot — the same shape the shipped schedule
 * page reads (`useWorkspaces((snapshot) => snapshot)`).
 *
 * @param list - the workspaces the snapshot carries.
 * @returns the selector hook.
 */
export function useWorkspacesOver(
  list: readonly WorkspaceRow[]
): (selector: (snapshot: unknown) => unknown) => unknown {
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
export function pageOf(registrations: Registration[]): React.ComponentType<Record<string, unknown>> {
  const row = registrations.find((entry) => entry.key === 'main');
  assert.ok(row !== undefined, 'a main panel is registered');
  return row.entry.component;
}

/**
 * Render the page into a fresh container in the shared document.
 *
 * @param registrations - the registrations from {@link mount}.
 * @param props - the props the slot owner would pass.
 * @returns handles for interacting with the mounted tree.
 */
export async function renderPage(
  registrations: Registration[],
  props: Record<string, unknown>
): Promise<MountedView> {
  const { dom } = loadBundle();
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(pageOf(registrations), props));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return {
    container,
    text: () => container.textContent ?? '',
    async click(selector: string): Promise<void> {
      const node = container.querySelector(selector);
      assert.ok(node !== null, `expected an element matching ${selector}`);
      await act(async () => {
        Simulate.click(node);
      });
    },
    async clickNode(node: Element | null | undefined): Promise<void> {
      assert.ok(node !== null && node !== undefined, 'expected a node to click');
      await act(async () => {
        Simulate.click(node);
      });
    },
    async type(selector: string, value: string): Promise<void> {
      const node = container.querySelector(selector);
      assert.ok(node !== null, `expected an element matching ${selector}`);
      // `Simulate` invokes the registered onChange handler directly. Dispatching a
      // synthetic `input` Event does not reach React 18's change plugin under this
      // Node+jsdom combination (unlike `click`, which does), and a real browser fires
      // trusted input events that React handles normally. The cast is needed because
      // React's own types describe a real `EventTarget`, which jsdom's node is not.
      await act(async () => {
        Simulate.change(node, { target: { value } } as unknown as Parameters<typeof Simulate.change>[1]);
      });
    },
    unmount(): void {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** A session store snapshot shaped like the client's `sessions` snapshot. */
export function sessionsSnapshot(
  rows: readonly { id: string; [field: string]: unknown }[]
): { ids: string[]; byId: Record<string, unknown> } {
  const byId: Record<string, unknown> = {};
  for (const row of rows) byId[row.id] = row;
  return { ids: rows.map((row) => row.id), byId };
}

/** A session face that always reports a retained, open session. */
export function openSessions(): {
  binding: () => Record<string, never>;
  using: (
    target: unknown,
    options: unknown,
    operation: (child: { binding: { session: { getSnapshot: () => { openState: string } } } }) => unknown
  ) => Promise<unknown>;
} {
  return {
    binding: () => ({}),
    using: (_target, _options, operation) =>
      Promise.resolve(operation({ binding: { session: { getSnapshot: () => ({ openState: 'open' }) } } })),
  };
}

/**
 * Flush a debounce and let React settle.
 * @param ms - how long to wait; the search box debounces at 300ms.
 */
export async function settle(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await act(async () => {});
}