// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentWorkWorkspace } from "../components/workspace/agent-work-workspace";

const fetchMock = vi.fn();
const selectProjectMock = vi.fn();
const selectSessionMock = vi.fn();
const showWorkspaceMock = vi.fn();
let tokenDeleted = false;
let projects: Array<{ id: string; title: string; updatedAt: string; createdAt: string; sessionCount: number }> = [];

const runnerStatus = {
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

vi.mock("../components/context/workspace-surface", () => ({
  useWorkspaceSurface: () => ({
    showWorkspace: showWorkspaceMock,
  }),
}));

vi.mock("../components/context/persisted-sessions", () => ({
  usePersistedSessions: () => ({
    selectSession: selectSessionMock,
  }),
}));

vi.mock("../components/context/projects", () => ({
  useProjects: () => ({
    selectProject: selectProjectMock,
  }),
}));

vi.stubGlobal("fetch", fetchMock);

afterEach(() => cleanup());

describe("AgentWorkWorkspace", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    selectProjectMock.mockReset();
    selectSessionMock.mockReset();
    showWorkspaceMock.mockReset();
    tokenDeleted = false;
    projects = [];

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/agents/codex/control")) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { action?: string };
          return Response.json({
            status: runnerStatus,
            login: body.action === "auth.login"
              ? { loginId: "login-1", userCode: "ABCD-EFGH", verificationUrl: "https://example.com/device" }
              : null,
          });
        }
        return Response.json({ status: runnerStatus, error: null });
      }
      if (url.startsWith("/api/agents/token")) {
        tokenDeleted = true;
        return Response.json({ revoked: true, tokenId: "token-1" });
      }
      return Response.json({
        agents: tokenDeleted ? [] : [
          {
            tokenId: "token-1",
            label: "CI bot",
            createdAt: "2026-04-21T09:00:00.000Z",
            expiresAt: "2026-04-25T10:30:00.000Z",
            lastUsedAt: null,
            eventCount: 1,
            sessionIds: [],
            projectIds: [],
          },
        ],
        sessions: [],
        projects,
        events: [],
      });
    });
  });

  it("deletes a saved token from the dashboard activity view", async () => {
    const user = userEvent.setup();
    render(<AgentWorkWorkspace />);

    expect(await screen.findByRole("button", { name: /CI bot/i })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Delete token" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    const deleteCall = fetchMock.mock.calls.find(([input]) => String(input).startsWith("/api/agents/token"));
    expect(deleteCall?.[0]).toBe("/api/agents/token?tokenId=token-1");
    expect(deleteCall?.[1]).toMatchObject({ method: "DELETE" });
    expect(await screen.findByText(/No agents recorded yet/i)).not.toBeNull();
  });

  it("starts Codex device sign-in from the runner control plane", async () => {
    projects = [{
      id: "project-1",
      title: "Runner project",
      updatedAt: "2026-04-21T09:00:00.000Z",
      createdAt: "2026-04-21T09:00:00.000Z",
      sessionCount: 1,
    }];
    const user = userEvent.setup();
    render(<AgentWorkWorkspace />);

    const authSwitch = await screen.findByRole("switch", { name: "Codex authentication" });
    expect(authSwitch.getAttribute("aria-checked")).toBe("false");
    await user.click(authSwitch);

    expect(await screen.findByText("ABCD-EFGH")).not.toBeNull();
    expect(screen.getByRole("link", { name: /Open verification page/i }).getAttribute("href")).toBe("https://example.com/device");
    const controlCall = fetchMock.mock.calls.find(([, init]) => {
      if (init?.method !== "POST") return false;
      return JSON.parse(String(init.body)).action === "auth.login";
    });
    expect(controlCall?.[0]).toBe("/api/agents/codex/control");
    expect(JSON.parse(String(controlCall?.[1]?.body))).toMatchObject({
      action: "auth.login",
      workspaceId: "project-1",
    });
  });
});
