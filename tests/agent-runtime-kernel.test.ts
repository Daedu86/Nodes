import { describe, expect, it } from "vitest";
import {
  AGENT_KERNEL_CAPABILITIES,
  AGENT_RUNTIME_EVENTS,
  AGENT_RUNTIME_INTERCEPTORS,
  createAgentRuntimeKernel,
  runAgentRuntimeStartPipeline,
} from "@/lib/agents/runtime/kernel";

describe("agent runtime kernel", () => {
  it("ships core capabilities and can wrap provider starts through plugins", async () => {
    const kernel = createAgentRuntimeKernel();
    const events: string[] = [];
    let startedPrompt: string | null = null;
    kernel.mount({
      id: "runtime-test-plugin",
      apply(context) {
        context.intercept<
          { runtime: string; request: { prompt: string } },
          { runId: string; prompt: string }
        >(AGENT_RUNTIME_INTERCEPTORS.start, async (envelope, next) => next({
          ...envelope,
          request: { prompt: `${envelope.request.prompt} + policy` },
        }));
        context.on<{
          runtime: string;
          request: { prompt: string };
          response: { runId: string; prompt: string };
        }>(AGENT_RUNTIME_EVENTS.started, (event) => {
          events.push("started");
          startedPrompt = event.request.prompt;
        });
      },
    });

    const result = await runAgentRuntimeStartPipeline(
      "test",
      { prompt: "original" },
      async (request) => ({ runId: "run-1", prompt: request.prompt }),
      kernel,
    );

    expect(kernel.has(AGENT_KERNEL_CAPABILITIES.tools)).toBe(true);
    expect(kernel.has(AGENT_KERNEL_CAPABILITIES.sessionLogFactory)).toBe(true);
    expect(kernel.has(AGENT_KERNEL_CAPABILITIES.requestAssembler)).toBe(true);
    expect(kernel.has(AGENT_KERNEL_CAPABILITIES.policyResolver)).toBe(true);
    expect(kernel.has(AGENT_KERNEL_CAPABILITIES.metricsCollector)).toBe(true);
    expect(result).toEqual({ runId: "run-1", prompt: "original + policy" });
    expect(startedPrompt).toBe("original + policy");
    expect(events).toEqual(["started"]);
  });
});
