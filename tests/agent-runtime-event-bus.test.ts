import { describe, expect, it, vi } from "vitest";
import { codexEventToRuntimeEvent } from "@/lib/agents/runtime/codex-event-adapter";
import { AgentRuntimeEventBus } from "@/lib/agents/runtime/event-bus";

describe("AgentRuntimeEventBus", () => {
  it("assigns monotonic sequence numbers and supports resumable reads", () => {
    const bus = new AgentRuntimeEventBus({
      clock: () => "2026-08-04T12:00:00.000Z",
      createEventId: () => "generated-id",
    });

    const first = bus.publish({
      runId: "run-1",
      nodeId: "node-1",
      runtime: "codex",
      type: "run.queued",
      source: "compiler",
    });
    const second = bus.publish({
      runId: "run-1",
      nodeId: "node-1",
      runtime: "codex",
      type: "agent.started",
      source: "runtime",
    });

    expect(first).toMatchObject({ id: "generated-id", sequence: 1 });
    expect(second).toMatchObject({ id: "generated-id", sequence: 2 });
    expect(bus.list("run-1", 1)).toEqual([second]);
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const bus = new AgentRuntimeEventBus({ createEventId: () => "event-id" });
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("run-1", listener);

    bus.publish({
      runId: "run-1",
      nodeId: "node-1",
      runtime: "codex",
      type: "agent.started",
      source: "runtime",
    });
    unsubscribe();
    bus.publish({
      runId: "run-1",
      nodeId: "node-1",
      runtime: "codex",
      type: "run.completed",
      source: "runtime",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }));
  });

  it("keeps a bounded backlog while preserving the resume sequence", () => {
    const bus = new AgentRuntimeEventBus({ maxEventsPerRun: 2, createEventId: () => "event-id" });
    for (const type of ["run.queued", "agent.started", "run.completed"] as const) {
      bus.publish({
        runId: "run-1",
        nodeId: "node-1",
        runtime: "codex",
        type,
        source: "runtime",
      });
    }

    expect(bus.list("run-1").map((event) => event.sequence)).toEqual([2, 3]);
    expect(bus.list("run-1", 2).map((event) => event.type)).toEqual(["run.completed"]);
  });
});

describe("codexEventToRuntimeEvent", () => {
  it("preserves the legacy provider payload in the common event envelope", () => {
    const draft = codexEventToRuntimeEvent({
      id: "codex-event-1",
      runId: "run-1",
      threadId: "thread-1",
      parentRunId: null,
      agentId: "agent-1",
      type: "shell.completed",
      createdAt: "2026-08-04T12:00:00.000Z",
      payload: { method: "item/completed", params: { item: { type: "commandExecution" } } },
    }, "node-1");

    expect(draft).toEqual({
      id: "codex-event-1",
      runId: "run-1",
      nodeId: "node-1",
      runtime: "codex",
      type: "shell.completed",
      source: "runtime",
      createdAt: "2026-08-04T12:00:00.000Z",
      parentRunId: null,
      payload: { method: "item/completed", params: { item: { type: "commandExecution" } } },
    });
  });
});
