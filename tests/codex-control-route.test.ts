import { beforeEach, describe, expect, it, vi } from "vitest";

const requireLocalApiUserMock = vi.hoisted(() => vi.fn());
const controlCodexRunnerMock = vi.hoisted(() => vi.fn());
const getCodexRunnerControlStatusMock = vi.hoisted(() => vi.fn());
const getCodexProjectRunnerStatusMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/server/request-guards", () => ({
  requireLocalApiUser: requireLocalApiUserMock,
}));

vi.mock("../lib/agents/codex/runner-client", () => ({
  controlCodexRunner: controlCodexRunnerMock,
  getCodexRunnerControlStatus: getCodexRunnerControlStatusMock,
}));

vi.mock("../lib/agents/codex/runner-status", () => ({
  getCodexProjectRunnerStatus: getCodexProjectRunnerStatusMock,
}));

import { GET, POST } from "../app/api/agents/codex/control/route";

const status = {
  activeRunCount: 0,
  authenticated: false,
  codexRunning: true,
  controlAvailable: true,
  hasDefaultWorkspace: true,
  model: "gpt-5.6-luna",
  ok: true,
  reachable: true,
  tychoImage: null,
  tychoReady: false,
  tychoRuntime: null,
  tychoStatus: "not_installed",
  workspaceConfigured: false,
  workspaceCount: 0,
  workspaceManaged: false,
};

describe("/api/agents/codex/control", () => {
  beforeEach(() => {
    requireLocalApiUserMock.mockReset();
    controlCodexRunnerMock.mockReset();
    getCodexRunnerControlStatusMock.mockReset();
    getCodexProjectRunnerStatusMock.mockReset();
    requireLocalApiUserMock.mockResolvedValue({
      user: { id: "user-1", email: "user@example.com", isAgent: false, name: "User" },
    });
    getCodexRunnerControlStatusMock.mockResolvedValue(status);
    controlCodexRunnerMock.mockResolvedValue({ status, login: null });
  });

  it("reads non-starting runner control status for a project", async () => {
    const response = await GET(new Request("http://localhost/api/agents/codex/control?workspaceId=project-1"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status, error: null });
    expect(getCodexRunnerControlStatusMock).toHaveBeenCalledWith("user-1", "project-1");
  });

  it("forwards an explicit device-login action", async () => {
    controlCodexRunnerMock.mockResolvedValue({
      status,
      login: {
        loginId: "login-1",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://example.com/device",
      },
    });

    const response = await POST(new Request("http://localhost/api/agents/codex/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "auth.login", workspaceId: "project-1" }),
    }));

    expect(response.status).toBe(200);
    expect(controlCodexRunnerMock).toHaveBeenCalledWith("user-1", "auth.login", "project-1");
    await expect(response.json()).resolves.toMatchObject({
      login: { userCode: "ABCD-EFGH" },
      error: null,
    });
  });

  it("requires a selected project for workspace changes", async () => {
    const response = await POST(new Request("http://localhost/api/agents/codex/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "workspace.attach" }),
    }));

    expect(response.status).toBe(400);
    expect(controlCodexRunnerMock).not.toHaveBeenCalled();
  });

  it("reports a reachable legacy runner without pretending controls exist", async () => {
    getCodexRunnerControlStatusMock.mockRejectedValue(new Error("not found"));
    getCodexProjectRunnerStatusMock.mockResolvedValue({
      authenticated: true,
      codexRunning: true,
      hasDefaultWorkspace: true,
      model: "gpt-5.6-luna",
      ok: true,
      reachable: true,
      tycho: { image: null, ready: true, runtime: "docker", reason: null, decision: "ready" },
      workspaceConfigured: true,
      workspaceCount: 1,
    });

    const response = await GET(new Request("http://localhost/api/agents/codex/control?workspaceId=project-1"));
    const body = await response.json();

    expect(body.status.controlAvailable).toBe(false);
    expect(body.status.reachable).toBe(true);
    expect(body.error).toMatch(/Update and restart/i);
  });
});
