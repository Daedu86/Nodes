import type {
  AgentKernelCapabilityDescriptor,
  AgentKernelDisposer,
  AgentKernelEventListener,
  AgentKernelInterceptor,
  AgentKernelPlugin,
  AgentKernelPluginContext,
} from "@/lib/agents/kernel/types";

type UnknownListener = AgentKernelEventListener<unknown>;
type UnknownInterceptor = AgentKernelInterceptor<unknown, unknown>;

type CapabilityRegistration = {
  pluginId: string;
  value: unknown;
};

type MountedPlugin = {
  id: string;
  requires: readonly string[];
  providedCapabilities: ReadonlySet<string>;
  dispose: AgentKernelDisposer;
};

const normalizedName = (value: string, kind: string) => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Agent kernel ${kind} must not be empty.`);
  return normalized;
};

const once = (disposer: AgentKernelDisposer): AgentKernelDisposer => {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    disposer();
  };
};

const disposeReverse = (disposers: readonly AgentKernelDisposer[]) => {
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    disposers[index]();
  }
};

/**
 * Small provider-neutral microkernel for agent capabilities.
 *
 * Plugins register capabilities, observers, waterfall interceptors and effects.
 * Every registration receives an idempotent disposer, so a failed mount can
 * roll back completely and an unload can reverse its effects deterministically.
 */
export class AgentKernel {
  private readonly capabilities = new Map<string, CapabilityRegistration>();
  private readonly listeners = new Map<string, Set<UnknownListener>>();
  private readonly interceptors = new Map<string, UnknownInterceptor[]>();
  private readonly mounted = new Map<string, MountedPlugin>();
  private readonly mountOrder: string[] = [];

  mount(plugin: AgentKernelPlugin): AgentKernelDisposer {
    const pluginId = normalizedName(plugin.id, "plugin id");
    if (this.mounted.has(pluginId)) {
      throw new Error(`Agent kernel plugin '${pluginId}' is already mounted.`);
    }

    const requires = (plugin.requires ?? []).map((name) =>
      normalizedName(name, "capability dependency"),
    );
    const missing = requires.filter((name) => !this.capabilities.has(name));
    if (missing.length) {
      throw new Error(
        `Agent kernel plugin '${pluginId}' requires missing capabilities: ${missing.join(", ")}.`,
      );
    }

    const disposers: AgentKernelDisposer[] = [];
    const providedCapabilities = new Set<string>();

    const context: AgentKernelPluginContext = {
      pluginId,
      provide: <TValue>(name: string, value: TValue) => {
        const capability = normalizedName(name, "capability name");
        const existing = this.capabilities.get(capability);
        if (existing) {
          throw new Error(
            `Agent kernel capability '${capability}' is already provided by '${existing.pluginId}'.`,
          );
        }

        this.capabilities.set(capability, { pluginId, value });
        providedCapabilities.add(capability);
        const dispose = once(() => {
          const current = this.capabilities.get(capability);
          if (current?.pluginId === pluginId) this.capabilities.delete(capability);
        });
        disposers.push(dispose);
        return dispose;
      },
      get: <TValue>(name: string) => this.get<TValue>(name),
      optional: <TValue>(name: string) => this.optional<TValue>(name),
      on: <TPayload>(event: string, listener: AgentKernelEventListener<TPayload>) => {
        const eventName = normalizedName(event, "event name");
        const listeners = this.listeners.get(eventName) ?? new Set<UnknownListener>();
        const stored = listener as unknown as UnknownListener;
        listeners.add(stored);
        this.listeners.set(eventName, listeners);

        const dispose = once(() => {
          const current = this.listeners.get(eventName);
          if (!current) return;
          current.delete(stored);
          if (!current.size) this.listeners.delete(eventName);
        });
        disposers.push(dispose);
        return dispose;
      },
      intercept: <TInput, TOutput>(
        point: string,
        interceptor: AgentKernelInterceptor<TInput, TOutput>,
      ) => {
        const pointName = normalizedName(point, "interceptor point");
        const interceptors = this.interceptors.get(pointName) ?? [];
        const stored = interceptor as unknown as UnknownInterceptor;
        interceptors.push(stored);
        this.interceptors.set(pointName, interceptors);

        const dispose = once(() => {
          const current = this.interceptors.get(pointName);
          if (!current) return;
          const index = current.indexOf(stored);
          if (index >= 0) current.splice(index, 1);
          if (!current.length) this.interceptors.delete(pointName);
        });
        disposers.push(dispose);
        return dispose;
      },
      emit: <TPayload>(event: string, payload: TPayload) => this.emit(event, payload),
      effect: (setup) => {
        const cleanup = setup();
        if (cleanup) disposers.push(once(cleanup));
      },
    };

    try {
      const cleanup = plugin.apply(context);
      if (cleanup) disposers.push(once(cleanup));
    } catch (error) {
      disposeReverse(disposers);
      throw error;
    }

    const mounted: MountedPlugin = {
      id: pluginId,
      requires,
      providedCapabilities,
      dispose: once(() => disposeReverse(disposers)),
    };
    this.mounted.set(pluginId, mounted);
    this.mountOrder.push(pluginId);

    return once(() => this.unmount(pluginId));
  }

  unmount(pluginId: string) {
    const normalized = normalizedName(pluginId, "plugin id");
    const mounted = this.mounted.get(normalized);
    if (!mounted) return;

    const dependent = [...this.mounted.values()].find(
      (candidate) =>
        candidate.id !== normalized &&
        candidate.requires.some((required) => mounted.providedCapabilities.has(required)),
    );
    if (dependent) {
      throw new Error(
        `Cannot unmount '${normalized}' while '${dependent.id}' depends on one of its capabilities.`,
      );
    }

    mounted.dispose();
    this.mounted.delete(normalized);
    const orderIndex = this.mountOrder.lastIndexOf(normalized);
    if (orderIndex >= 0) this.mountOrder.splice(orderIndex, 1);
  }

  get<TValue>(name: string): TValue {
    const capability = normalizedName(name, "capability name");
    const registration = this.capabilities.get(capability);
    if (!registration) {
      throw new Error(`Agent kernel capability '${capability}' is not available.`);
    }
    return registration.value as TValue;
  }

  optional<TValue>(name: string): TValue | undefined {
    const capability = normalizedName(name, "capability name");
    return this.capabilities.get(capability)?.value as TValue | undefined;
  }

  has(name: string) {
    return this.capabilities.has(normalizedName(name, "capability name"));
  }

  listCapabilities(): AgentKernelCapabilityDescriptor[] {
    return [...this.capabilities.entries()].map(([name, registration]) => ({
      name,
      pluginId: registration.pluginId,
    }));
  }

  listPlugins(): string[] {
    return [...this.mountOrder];
  }

  async emit<TPayload>(event: string, payload: TPayload): Promise<void> {
    const eventName = normalizedName(event, "event name");
    const listeners = [...(this.listeners.get(eventName) ?? [])];
    for (const listener of listeners) {
      await listener(payload);
    }
  }

  async runWaterfall<TInput, TOutput>(
    point: string,
    input: TInput,
    terminal: (input: TInput) => Promise<TOutput>,
  ): Promise<TOutput> {
    const pointName = normalizedName(point, "interceptor point");
    const stack = [...(this.interceptors.get(pointName) ?? [])];

    const dispatch = async (index: number, current: unknown): Promise<unknown> => {
      const interceptor = stack[index];
      if (!interceptor) return terminal(current as TInput);

      let delegated = false;
      return interceptor(current, async (nextInput = current) => {
        if (delegated) {
          throw new Error(
            `Agent kernel interceptor at '${pointName}' called next() more than once.`,
          );
        }
        delegated = true;
        return dispatch(index + 1, nextInput);
      });
    };

    return dispatch(0, input) as Promise<TOutput>;
  }

  dispose() {
    for (let index = this.mountOrder.length - 1; index >= 0; index -= 1) {
      this.unmount(this.mountOrder[index]);
    }
  }
}
