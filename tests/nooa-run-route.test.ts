import { beforeEach, describe, expect, it, vi } from "vitest";

const requireLocalApiUserMock = vi.hoisted(() => vi.fn());
const getSessionMock = vi.hoisted(() => vi.fn());
const recordAgentEventMock = vi.hoisted(() => vi.fn());
const startNooaRunMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/server/request-guards", () => ({
  requireLocalApiUser: requireLocalApiUserMock,
}));
vi.mock("../lib/session-store", () => ({
  getSession: getSessionMock,
}));
vi.mock("../lib/server/agent-work", () => ({
  recordAgentEvent: recordAgentEventMock,
}));
vi.mock("../lib/agents/nooa/runner-client", () => ({
  startNooaRun: startNooaRunMock,
}));

import { POST } from "../app/api/agents/nooa/runs/route";

const validNode = {
  id: "nooa-node-1",
  runtime: "nooa",
  sessionId: "session-1",
  prompt: "Inspect this workspace.",
  role: "custom",
  projectId: "project-1",
  workspaceId: "project-1",
  sandbox: { provider: "openshell", policyId: "code-safe" },
};

describe("POST /api/agents/nooa/runs", () => {
  beforeEach(() => {
    requireLocalApiUserMock.mockReset();
    getSessionMock.mockReset();
    recordAgentEventMock.mockReset();
    startNooaRunMock.mockReset();

    requireLocalApiUserMock.mockResolvedValue({
      user: {
        id: "user-1",
        agentTokenId: null,
        agentLabel: null,
      },
    });
    getSessionMock.mockResolvedValue({ id: "session-1" });
    recordAgentEventMock.mockResolvedValue(undefined);
    startNooaRunMock.mockResolvedValue({
      runId: "run-1",
      runtime: "nooa",
      nodeId: "nooa-node-1",
      status: "queued",
      providerRunId: "nodes-nooa-run-1",
    });
  });

  it("compiles a NOOA node before forwarding it to the private runner", async () => {
    const response = await POST(new Request("http://localhost/api/agents/nooa/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validNode),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ runId: "run-1", runtime: "nooa" });
    expect(getSessionMock).toHaveBeenCalledWith("session-1", "user-1");
    expect(startNooaRunMock).toHaveBeenCalledWith({
      ownerId: "user-1",
      run: expect.objectContaining({
        nodeId: "nooa-node-1",
        runtime: "nooa",
        sandbox: { provider: "openshell", policyId: "code-safe", profileId: null },
        workspaceId: "project-1",
      }),
    });
    expect(recordAgentEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "nooa.run.requested",
      sessionId: "session-1",
    }));
  });

  it("rejects a NOOA node without a server-resolvable OpenShell policy id", async () => {
    const response = await POST(new Request("http://localhost/api/agents/nooa/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validNode, sandbox: null }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "NOOA agent node is invalid.",
      issues: [expect.objectContaining({ code: "missing_openshell_policy" })],
    });
    expect(startNooaRunMock).not.toHaveBeenCalled();
  });
});
