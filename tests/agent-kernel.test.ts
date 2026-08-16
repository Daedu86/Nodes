import { describe, expect, it } from "vitest";
import { AgentKernel } from "@/lib/agents/kernel/kernel";

describe("AgentKernel", () => {
  it("mounts reversible capabilities and event listeners", async () => {
    const kernel = new AgentKernel();
    const observed: string[] = [];

    const unmount = kernel.mount({
      id: "example.plugin",
      apply(context) {
        context.provide("example.answer", 42);
        context.on<string>("example.event", (payload) => { observed.push(payload); });
      },
    });

    expect(kernel.get<number>("example.answer")).toBe(42);
    await kernel.emit("example.event", "seen");
    expect(observed).toEqual(["seen"]);

    unmount();
    expect(kernel.has("example.answer")).toBe(false);
    await kernel.emit("example.event", "ignored");
    expect(observed).toEqual(["seen"]);
  });

  it("rolls back partial registrations when a plugin fails to mount", () => {
    const kernel = new AgentKernel();

    expect(() => kernel.mount({
      id: "broken.plugin",
      apply(context) {
        context.provide("temporary.capability", { ok: true });
        throw new Error("boom");
      },
    })).toThrow("boom");

    expect(kernel.has("temporary.capability")).toBe(false);
    expect(kernel.listPlugins()).toEqual([]);
  });

  it("protects mounted capability dependencies", () => {
    const kernel = new AgentKernel();
    kernel.mount({
      id: "provider",
      apply(context) {
        context.provide("shared.service", { version: 1 });
      },
    });
    kernel.mount({
      id: "consumer",
      requires: ["shared.service"],
      apply() {
        return undefined;
      },
    });

    expect(() => kernel.unmount("provider")).toThrow(
      "Cannot unmount 'provider' while 'consumer' depends on one of its capabilities.",
    );
    kernel.unmount("consumer");
    kernel.unmount("provider");
    expect(kernel.listPlugins()).toEqual([]);
  });

  it("runs waterfall interceptors in registration order", async () => {
    const kernel = new AgentKernel();
    const order: string[] = [];
    kernel.mount({
      id: "interceptors",
      apply(context) {
        context.intercept<{ value: number }, number>("runtime.start", async (input, next) => {
          order.push("outer:before");
          const result = await next({ value: input.value + 1 });
          order.push("outer:after");
          return result + 1;
        });
        context.intercept<{ value: number }, number>("runtime.start", async (input, next) => {
          order.push("inner:before");
          const result = await next({ value: input.value * 2 });
          order.push("inner:after");
          return result + 2;
        });
      },
    });

    const result = await kernel.runWaterfall(
      "runtime.start",
      { value: 3 },
      async ({ value }) => value,
    );

    expect(result).toBe(11);
    expect(order).toEqual([
      "outer:before",
      "inner:before",
      "inner:after",
      "outer:after",
    ]);
  });
});
