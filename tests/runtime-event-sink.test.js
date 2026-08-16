import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeEventSink } from "../services/runtime-event-sink.mjs";

describe("runtime event sink", () => {
  it("serializes an authenticated runner event delivery", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 201 }));
    const sink = createRuntimeEventSink({
      runtime: "nooa",
      runnerToken: "secret",
      fetchImpl,
      retryDelaysMs: [0],
    });
    const delivered = await sink.enqueue({
      ownerId: "owner-1",
      sessionId: "session-1",
      projectId: "project-1",
      journalId: "journal-1",
      runId: "run-1",
      eventSinkUrl: "https://nodes.example/api/agents/runtime-events",
    }, { id: "event-1", runId: "run-1" });

    expect(delivered).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://nodes.example/api/agents/runtime-events");
    expect(init.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body)).toMatchObject({
      runtime: "nooa",
      ownerId: "owner-1",
      journalId: "journal-1",
      runId: "run-1",
      event: { id: "event-1" },
    });
  });

  it("serializes parent and child deliveries that share one journal", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true, status: 201 };
    });
    const sink = createRuntimeEventSink({
      runtime: "codex",
      runnerToken: "secret",
      fetchImpl,
      retryDelaysMs: [0],
    });
    const base = {
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-1",
      eventSinkUrl: "https://nodes.example/api/agents/runtime-events",
    };
    await Promise.all([
      sink.enqueue({ ...base, runId: "parent" }, { id: "event-1" }),
      sink.enqueue({ ...base, runId: "child" }, { id: "event-2" }),
    ]);
    expect(maxInFlight).toBe(1);
  });

  it("persists failed deliveries and replays them after runner restart", async () => {
    const outboxDir = mkdtempSync(path.join(tmpdir(), "nodes-runtime-outbox-"));
    const run = {
      ownerId: "owner-1",
      sessionId: "session-1",
      projectId: "project-1",
      journalId: "journal-1",
      runId: "run-1",
      eventSinkUrl: "https://nodes.example/api/agents/runtime-events",
    };

    try {
      const failing = createRuntimeEventSink({
        runtime: "codex",
        runnerToken: "secret",
        outboxDir,
        fetchImpl: async () => {
          throw new Error("callback offline");
        },
        retryDelaysMs: [0],
      });

      await expect(failing.enqueue(run, { id: "event-1", runId: "run-1" }))
        .rejects.toThrow("callback offline");
      expect(readdirSync(outboxDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);

      const replayFetch = vi.fn(async () => ({ ok: true, status: 201 }));
      const recovered = createRuntimeEventSink({
        runtime: "codex",
        runnerToken: "secret",
        outboxDir,
        fetchImpl: replayFetch,
        retryDelaysMs: [0],
      });

      await expect(recovered.recover()).resolves.toEqual({
        attempted: 1,
        delivered: 1,
        failed: 0,
      });
      expect(replayFetch).toHaveBeenCalledTimes(1);
      expect(readdirSync(outboxDir).filter((name) => name.endsWith(".json"))).toHaveLength(0);
    } finally {
      rmSync(outboxDir, { recursive: true, force: true });
    }
  });

  it("retries retryable failures and stays disabled without a shared secret", async () => {
    const retryingFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const retrying = createRuntimeEventSink({
      runtime: "codex",
      runnerToken: "secret",
      fetchImpl: retryingFetch,
      retryDelaysMs: [0, 0],
      sleepImpl: async () => undefined,
    });
    await expect(retrying.enqueue({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-1",
      runId: "run-1",
      eventSinkUrl: "https://nodes.example/api/agents/runtime-events",
    }, { id: "event-1", runId: "run-1" })).resolves.toBe(true);
    expect(retryingFetch).toHaveBeenCalledTimes(2);

    const disabledFetch = vi.fn();
    const disabled = createRuntimeEventSink({
      runtime: "codex",
      runnerToken: null,
      fetchImpl: disabledFetch,
      retryDelaysMs: [0],
    });
    await expect(disabled.enqueue({
      ownerId: "owner-1",
      sessionId: "session-1",
      journalId: "journal-1",
      runId: "run-1",
      eventSinkUrl: "https://nodes.example/api/agents/runtime-events",
    }, { id: "event-1" })).resolves.toBe(false);
    expect(disabledFetch).not.toHaveBeenCalled();
  });
});
