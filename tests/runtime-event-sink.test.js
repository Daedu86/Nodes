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
