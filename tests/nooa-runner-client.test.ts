import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelNooaRun, startNooaRun, streamNooaRunEvents } from "@/lib/agents/nooa/runner-client";

const fetchMock = vi.fn();

describe("NOOA runner client", () => {
  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("forwards a compiled run with the private runner token and owner header", async () => {
    vi.stubEnv("NOOA_RUNNER_URL", "http://127.0.0.1:8788/");
    vi.stubEnv("NOOA_RUNNER_TOKEN", "runner-secret");
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      runId: "run-1",
      runtime: "nooa",
      nodeId: "node-1",
      status: "running",
      providerRunId: "nodes-nooa-run-1",
    }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(startNooaRun({
      ownerId: "owner-1",
      run: {
        schemaVersion: 1,
        runtime: "nooa",
        nodeId: "node-1",
        sessionId: "session-1",
        prompt: "Inspect the project",
        label: "NOOA Agent",
        role: "custom",
        projectId: null,
        workspaceId: "project-a",
        parentRunId: null,
        sandbox: { provider: "openshell", policyId: "code-safe", profileId: null },
        metadata: {},
      },
    })).resolves.toEqual({
      runId: "run-1",
      runtime: "nooa",
      nodeId: "node-1",
      status: "running",
      providerRunId: "nodes-nooa-run-1",
      threadId: null,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8788/v1/runs");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer runner-secret");
    expect(headers.get("x-nodes-owner-id")).toBe("owner-1");
  });

  it("uses encoded run ids for streaming and cancellation", async () => {
    vi.stubEnv("NOOA_RUNNER_URL", "http://127.0.0.1:8788");
    fetchMock
      .mockResolvedValueOnce(new Response("stream", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await streamNooaRunEvents("owner-1", "run / 1", "event / 1");
    await cancelNooaRun("owner-1", "run / 1");

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:8788/v1/runs/run%20%2F%201/events?after=event%20%2F%201");
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:8788/v1/runs/run%20%2F%201/cancel");
  });
});
