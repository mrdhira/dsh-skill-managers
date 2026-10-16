/**
 * The DSH client contract this plugin's browser half relies on.
 *
 * **Observed, not published.** Every shape below was read off a real surface and marked
 * with where it was seen. None of it is a published API: a DSH update can change it.
 */

/** The CommonJS `require` the client loader hands the bundle factory. */
declare const require: (name: string) => unknown;
/** The module object `build.mjs`'s banner creates; the factory returns its `exports`. */
declare const module: { exports: unknown };
/** The build stamp `build.mjs` injects. */
declare const __BUILD_ID__: string;

/** A slot contribution's registration options. */
interface DshSlotRegistration {
  readonly name: string;
  readonly id?: string;
  readonly key?: string;
  readonly order?: number;
  readonly label?: string | (() => string);
  readonly inject?: unknown;
}

/** The `slots` service, as this plugin uses it. */
interface DshSlotsService {
  inject(slotName: string, run: () => unknown): unknown;
  register(spec: DshSlotRegistration, component: unknown): unknown;
}

/** The restricted client context a plugin half is applied with. */
interface DshClientContext {
  readonly slots: DshSlotsService;
  readonly sessions?: unknown;
  readonly workspaces?: unknown;
  readonly remote?: { skills?: unknown };
  get(name: string): unknown;
}

/** The `skills` host service, limited to the one call the host half makes. */
interface DshSkillsService {
  registerProvider(
    create: () => {
      name: string;
      list(): Promise<{ candidates: readonly unknown[]; complete: boolean }>;
      get(candidate: unknown, options: { signal?: AbortSignal }): Promise<unknown>;
    }
  ): () => void;
}

/** One durable workspace registration, as `workspaceRegistry.list()` returns it. */
interface DshWorkspace {
  readonly id: string;
  readonly path: string;
  readonly title: string;
}
