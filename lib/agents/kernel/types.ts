export type AgentKernelDisposer = () => void;

export type AgentKernelEventListener<TPayload = unknown> = (
  payload: TPayload,
) => void | Promise<void>;

export type AgentKernelNext<TInput, TOutput> = (
  input?: TInput,
) => Promise<TOutput>;

export type AgentKernelInterceptor<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  next: AgentKernelNext<TInput, TOutput>,
) => Promise<TOutput>;

export type AgentKernelCapabilityDescriptor = {
  name: string;
  pluginId: string;
};

export type AgentKernelPluginContext = {
  readonly pluginId: string;
  provide<TValue>(name: string, value: TValue): AgentKernelDisposer;
  get<TValue>(name: string): TValue;
  optional<TValue>(name: string): TValue | undefined;
  on<TPayload>(
    event: string,
    listener: AgentKernelEventListener<TPayload>,
  ): AgentKernelDisposer;
  intercept<TInput, TOutput>(
    point: string,
    interceptor: AgentKernelInterceptor<TInput, TOutput>,
  ): AgentKernelDisposer;
  emit<TPayload>(event: string, payload: TPayload): Promise<void>;
  effect(setup: () => void | AgentKernelDisposer): void;
};

export type AgentKernelPlugin = {
  id: string;
  requires?: readonly string[];
  apply(context: AgentKernelPluginContext): void | AgentKernelDisposer;
};
