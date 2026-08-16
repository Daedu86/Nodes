import { describe, expect, it } from "vitest";
import { AgentToolRegistry } from "@/lib/agents/kernel/tools";

const stringSchema = {
  parse(value: unknown) {
    if (typeof value !== "string") throw new Error("expected string");
    return value;
  },
};

const objectSchema = {
  parse(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected object");
    }
    const record = value as Record<string, unknown>;
    if (typeof record.text !== "string") throw new Error("expected text");
    return { text: record.text };
  },
};

const passthroughSchema = {
  parse(value: unknown) {
    return value;
  },
};

const executionContext = (signal = new AbortController().signal) => ({
  runId: "run-1",
  callId: "call-1",
  signal,
});

describe("AgentToolRegistry", () => {
  it("validates inputs and outputs and exposes scheduling mode", async () => {
    const registry = new AgentToolRegistry();
    registry.register({
      name: "uppercase",
      description: "Uppercase text",
      input: objectSchema,
      output: stringSchema,
      executionMode: "parallel",
      execute: ({ text }) => text.toUpperCase(),
    });

    await expect(registry.execute<string>({
      name: "uppercase",
      arguments: { text: "nodes" },
      context: executionContext(),
    })).resolves.toEqual({
      name: "uppercase",
      callId: "call-1",
      mode: "parallel",
      value: "NODES",
    });

    await expect(registry.execute({
      name: "uppercase",
      arguments: { wrong: true },
      context: executionContext(),
    })).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });

  it("enforces a frozen lossless-JSON boundary around tool execution", async () => {
    const registry = new AgentToolRegistry();
    let receivedFrozenArguments = false;
    registry.register({
      name: "non-json-output",
      description: "Return an unsupported object",
      input: objectSchema,
      output: passthroughSchema,
      execute: (args) => {
        receivedFrozenArguments = Object.isFrozen(args);
        return new Date("2026-08-16T00:00:00.000Z");
      },
    });

    await expect(registry.execute({
      name: "non-json-output",
      arguments: { text: "nodes" },
      context: executionContext(),
    })).rejects.toMatchObject({
      code: "INVALID_OUTPUT",
      message: expect.stringContaining("non-plain object"),
    });
    expect(receivedFrozenArguments).toBe(true);
  });

  it("applies monotonic policy guards before execution", async () => {
    const registry = new AgentToolRegistry();
    let executed = false;
    registry.register({
      name: "shell",
      description: "Example guarded tool",
      input: stringSchema,
      output: stringSchema,
      execute: (value) => {
        executed = true;
        return value;
      },
    });
    registry.guard(async ({ name }) =>
      name === "shell"
        ? { allow: false, reason: "sandbox policy denied shell" }
        : { allow: true },
    );

    await expect(registry.execute({
      name: "shell",
      arguments: "pwd",
      context: executionContext(),
    })).rejects.toMatchObject({
      code: "DENIED",
      message: "sandbox policy denied shell",
    });
    expect(executed).toBe(false);
  });

  it("converts cooperative timeouts into a typed tool error", async () => {
    const registry = new AgentToolRegistry();
    registry.register({
      name: "slow",
      description: "Wait until cancelled",
      input: stringSchema,
      output: stringSchema,
      timeoutMs: 5,
      execute: (value, { signal }) => new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve(value), 100);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    });

    await expect(registry.execute({
      name: "slow",
      arguments: "late",
      context: executionContext(),
    })).rejects.toEqual(expect.objectContaining({
      code: "TIMEOUT",
    }));
  });
});
