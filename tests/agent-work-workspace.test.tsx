// @vitest-environment jsdom

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentWorkWorkspace } from "../components/workspace/agent-work-workspace";

const fetchMock = vi.fn();
const selectProjectMock = vi.fn();
const selectSessionMock = vi.fn();
const showWorkspaceMock = vi.fn();

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

describe("AgentWorkWorkspace", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    selectProjectMock.mockReset();
    selectSessionMock.mockReset();
    showWorkspaceMock.mockReset();

    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          agents: [
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
          projects: [],
          events: [],
        }),
      )
      .mockResolvedValueOnce(Response.json({ revoked: true, tokenId: "token-1" }))
      .mockResolvedValueOnce(
        Response.json({
          agents: [],
          sessions: [],
          projects: [],
          events: [],
        }),
      );
  });

  it("deletes a saved token from the dashboard activity view", async () => {
    const user = userEvent.setup();
    render(<AgentWorkWorkspace />);

    expect(await screen.findByRole("button", { name: /CI bot/i })).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Delete token" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/agents/token?tokenId=token-1");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(await screen.findByText(/No agents recorded yet/i)).not.toBeNull();
  });
});
