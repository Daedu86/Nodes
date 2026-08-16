export type AgentToolExecutionMode = "parallel" | "exclusive";

export type AgentToolSchema<TValue> = {
  parse(value: unknown): TValue;
};

export type AgentToolExecutionContext = {
  runId: string;
  callId: string;
  signal: AbortSignal;
  metadata?: Readonly<Record<string, unknown>>;
};

export type AgentToolDefinition<TArgs = unknown, TResult = unknown> = {
  name: string;
  description: string;
  input: AgentToolSchema<TArgs>;
  output: AgentToolSchema<TResult>;
  timeoutMs?: number;
  executionMode?:
    | AgentToolExecutionMode
    | ((args: TArgs) => AgentToolExecutionMode);
  execute(
    args: TArgs,
    context: AgentToolExecutionContext,
  ): Promise<TResult> | TResult;
};

export type AgentToolGuardDecision =
  | { allow: true }
  | { allow: false; reason: string };

export type AgentToolGuard = (input: {
  name: string;
  args: unknown;
  context: AgentToolExecutionContext;
}) => AgentToolGuardDecision | Promise<AgentToolGuardDecision>;

export type AgentToolExecutionInput = {
  name: string;
  arguments: unknown;
  context: AgentToolExecutionContext;
};

export type AgentToolExecutionResult<TResult = unknown> = {
  name: string;
  callId: string;
  mode: AgentToolExecutionMode;
  value: TResult;
};

export type AgentToolErrorCode =
  | "UNKNOWN_TOOL"
  | "INVALID_ARGS"
  | "INVALID_OUTPUT"
  | "DENIED"
  | "TIMEOUT"
  | "CANCELLED";

export class AgentToolError extends Error {
  readonly code: AgentToolErrorCode;
  readonly details?: unknown;

  constructor(code: AgentToolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AgentToolError";
    this.code = code;
    this.details = details;
  }
}

type StoredToolDefinition = AgentToolDefinition<unknown, unknown>;

type RegisteredTool = {
  definition: StoredToolDefinition;
};

const normalizedToolName = (value: string) => {
  const name = value.trim();
  if (!name) throw new Error("Agent tool name must not be empty.");
  return name;
};

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const cancellationError = (signal: AbortSignal) => {
  if (signal.reason instanceof AgentToolError) return signal.reason;
  return new AgentToolError(
    "CANCELLED",
    signal.reason instanceof Error
      ? signal.reason.message
      : "Agent tool execution was cancelled.",
    signal.reason,
  );
};

/**
 * Provider-neutral tool registry with validation, monotonic guards, cooperative
 * cancellation and execution-mode metadata.
 *
 * Schemas only need a `parse(unknown)` method, so Zod, Valibot or a custom
 * validator can be used without coupling the kernel to a validation library.
 */
export class AgentToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly guards: AgentToolGuard[] = [];

  register<TArgs, TResult>(
    definition: AgentToolDefinition<TArgs, TResult>,
  ): () => void {
    const name = normalizedToolName(definition.name);
    if (this.tools.has(name)) {
      throw new Error(`Agent tool '${name}' is already registered.`);
    }
    if (
      definition.timeoutMs !== undefined &&
      (!Number.isFinite(definition.timeoutMs) || definition.timeoutMs <= 0)
    ) {
      throw new Error(`Agent tool '${name}' timeoutMs must be a positive number.`);
    }

    const registered: RegisteredTool = {
      definition: {
        ...definition,
        name,
      } as StoredToolDefinition,
    };
    this.tools.set(name, registered);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.tools.get(name);
      if (current === registered) this.tools.delete(name);
    };
  }

  guard(guard: AgentToolGuard): () => void {
    this.guards.push(guard);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const index = this.guards.indexOf(guard);
      if (index >= 0) this.guards.splice(index, 1);
    };
  }

  list(): Array<{ name: string; description: string }> {
    return [...this.tools.values()].map(({ definition }) => ({
      name: definition.name,
      description: definition.description,
    }));
  }

  async execute<TResult = unknown>(
    input: AgentToolExecutionInput,
  ): Promise<AgentToolExecutionResult<TResult>> {
    const name = normalizedToolName(input.name);
    const registered = this.tools.get(name);
    if (!registered) {
      throw new AgentToolError("UNKNOWN_TOOL", `Agent tool '${name}' is not registered.`);
    }

    let args: unknown;
    try {
      args = registered.definition.input.parse(input.arguments);
    } catch (error) {
      throw new AgentToolError(
        "INVALID_ARGS",
        `Agent tool '${name}' rejected its arguments: ${errorMessage(error)}`,
        error,
      );
    }

    const mode = this.resolveExecutionMode(registered.definition, args);
    const { signal, cleanup, timeoutError } = this.createExecutionSignal(
      input.context.signal,
      registered.definition.timeoutMs,
      name,
    );
    const context: AgentToolExecutionContext = {
      ...input.context,
      signal,
    };

    try {
      if (signal.aborted) throw cancellationError(signal);

      for (const guard of [...this.guards]) {
        const decision = await guard({ name, args, context });
        if (signal.aborted) throw cancellationError(signal);
        if (!decision.allow) {
          throw new AgentToolError(
            "DENIED",
            decision.reason.trim() || `Agent tool '${name}' was denied by policy.`,
          );
        }
      }

      let rawResult: unknown;
      try {
        rawResult = await registered.definition.execute(args, context);
      } catch (error) {
        if (timeoutError.current) throw timeoutError.current;
        if (signal.aborted) throw cancellationError(signal);
        throw error;
      }
      if (timeoutError.current) throw timeoutError.current;
      if (signal.aborted) throw cancellationError(signal);

      let value: unknown;
      try {
        value = registered.definition.output.parse(rawResult);
      } catch (error) {
        throw new AgentToolError(
          "INVALID_OUTPUT",
          `Agent tool '${name}' returned an invalid result: ${errorMessage(error)}`,
          error,
        );
      }

      return {
        name,
        callId: input.context.callId,
        mode,
        value: value as TResult,
      };
    } finally {
      cleanup();
    }
  }

  private resolveExecutionMode(
    definition: StoredToolDefinition,
    args: unknown,
  ): AgentToolExecutionMode {
    const declared = typeof definition.executionMode === "function"
      ? definition.executionMode(args)
      : definition.executionMode;
    return declared === "parallel" ? "parallel" : "exclusive";
  }

  private createExecutionSignal(
    callerSignal: AbortSignal,
    timeoutMs: number | undefined,
    toolName: string,
  ) {
    const controller = new AbortController();
    const timeoutError: { current: AgentToolError | null } = { current: null };

    const forwardAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(callerSignal.reason);
      }
    };
    if (callerSignal.aborted) {
      forwardAbort();
    } else {
      callerSignal.addEventListener("abort", forwardAbort, { once: true });
    }

    const timeout = timeoutMs === undefined
      ? null
      : setTimeout(() => {
          const error = new AgentToolError(
            "TIMEOUT",
            `Agent tool '${toolName}' exceeded its ${timeoutMs}ms cooperative timeout.`,
          );
          timeoutError.current = error;
          if (!controller.signal.aborted) controller.abort(error);
        }, timeoutMs);

    return {
      signal: controller.signal,
      timeoutError,
      cleanup: () => {
        if (timeout !== null) clearTimeout(timeout);
        callerSignal.removeEventListener("abort", forwardAbort);
      },
    };
  }
}
