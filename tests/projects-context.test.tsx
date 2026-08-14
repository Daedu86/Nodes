// @vitest-environment jsdom

import React from "react";
import { SessionProvider } from "next-auth/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ProjectsProvider, useProjects } from "../components/context/projects";

const ACTIVE_PROJECT_KEY = "nodes.active-project-id.test-user";
const TEST_SESSION = {
  expires: "2099-01-01T00:00:00.000Z",
  user: {
    email: "test@nodes.local",
    id: "test-user",
    name: "Test User",
  },
};

const createJsonResponse = (payload: unknown) =>
  ({
    ok: true,
    json: async () => payload,
  }) as Response;

function ProjectsSnapshot() {
  const { activeProjectId, isReady, projects, selectProject } = useProjects();

  return (
    <div>
      <div data-testid="ready">{String(isReady)}</div>
      <div data-testid="active-project">{activeProjectId ?? "none"}</div>
      <div data-testid="project-count">{projects.length}</div>
      <button
        type="button"
        disabled={!activeProjectId}
        onClick={() => activeProjectId && void selectProject(activeProjectId)}
      >
        Refresh active project
      </button>
    </div>
  );
}

function renderWithSession(children: React.ReactNode) {
  return render(
    <SessionProvider session={TEST_SESSION}>
      {children}
    </SessionProvider>,
  );
}

describe("ProjectsProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("does not auto-open a large stored project on bootstrap", async () => {
    localStorage.setItem(ACTIVE_PROJECT_KEY, "project-large");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return createJsonResponse({
          projects: [
            {
              arenaWinnerBranchKey: null,
              arenaWinnerSessionId: null,
              createdAt: "2026-04-01T09:00:00.000Z",
              id: "project-large",
              memoryIds: [],
              sessionCount: 20,
              title: "Large project",
              updatedAt: "2026-04-01T09:00:00.000Z",
            },
          ],
        });
      }

      if (url === "/api/projects/project-large") {
        return createJsonResponse({
          project: {
            arenaWinnerBranchKey: null,
            arenaWinnerSessionId: null,
            createdAt: "2026-04-01T09:00:00.000Z",
            globalContext: "",
            id: "project-large",
            memoryIds: [],
            sessionCount: 20,
            sessionIds: Array.from({ length: 20 }, (_, index) => `session-${index + 1}`),
            title: "Large project",
            updatedAt: "2026-04-01T09:00:00.000Z",
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithSession(
      <ProjectsProvider>
        <ProjectsSnapshot />
      </ProjectsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });

    expect(screen.getByTestId("active-project").textContent).toBe("none");
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith("/api/projects/project-large", expect.anything());
  });

  it("still restores a normal stored project on bootstrap", async () => {
    localStorage.setItem(ACTIVE_PROJECT_KEY, "project-small");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return createJsonResponse({
          projects: [
            {
              arenaWinnerBranchKey: null,
              arenaWinnerSessionId: null,
              createdAt: "2026-04-01T09:00:00.000Z",
              id: "project-small",
              memoryIds: [],
              sessionCount: 2,
              title: "Small project",
              updatedAt: "2026-04-01T09:00:00.000Z",
            },
          ],
        });
      }

      if (url === "/api/projects/project-small") {
        return createJsonResponse({
          project: {
            arenaWinnerBranchKey: null,
            arenaWinnerSessionId: null,
            createdAt: "2026-04-01T09:00:00.000Z",
            globalContext: "Keep focus",
            id: "project-small",
            memoryIds: [],
            sessionCount: 2,
            sessionIds: ["session-a", "session-b"],
            title: "Small project",
            updatedAt: "2026-04-01T09:00:00.000Z",
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithSession(
      <ProjectsProvider>
        <ProjectsSnapshot />
      </ProjectsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });

    expect(screen.getByTestId("active-project").textContent).toBe("project-small");
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBe("project-small");
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/project-small", expect.anything());
  });

  it("keeps the project workspace ready while refreshing the active project", async () => {
    localStorage.setItem(ACTIVE_PROJECT_KEY, "project-small");
    let projectFetchCount = 0;
    let resolveRefresh: (() => void) | null = null;
    const projectPayload = {
      project: {
        arenaWinnerBranchKey: null,
        arenaWinnerSessionId: null,
        createdAt: "2026-04-01T09:00:00.000Z",
        globalContext: "Keep focus",
        id: "project-small",
        memoryIds: [],
        sessionCount: 2,
        sessionIds: ["session-a", "session-b"],
        title: "Small project",
        updatedAt: "2026-04-01T09:00:00.000Z",
      },
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return createJsonResponse({
          projects: [{
            arenaWinnerBranchKey: null,
            arenaWinnerSessionId: null,
            createdAt: "2026-04-01T09:00:00.000Z",
            id: "project-small",
            memoryIds: [],
            sessionCount: 2,
            title: "Small project",
            updatedAt: "2026-04-01T09:00:00.000Z",
          }],
        });
      }

      if (url === "/api/projects/project-small") {
        projectFetchCount += 1;
        if (projectFetchCount === 1) {
          return createJsonResponse(projectPayload);
        }
        return await new Promise<Response>((resolve) => {
          resolveRefresh = () => resolve(createJsonResponse(projectPayload));
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithSession(
      <ProjectsProvider>
        <ProjectsSnapshot />
      </ProjectsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
      expect(screen.getByTestId("active-project").textContent).toBe("project-small");
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh active project" }));

    await waitFor(() => {
      expect(projectFetchCount).toBe(2);
    });
    expect(screen.getByTestId("ready").textContent).toBe("true");

    await act(async () => {
      resolveRefresh?.();
    });
  });

  it("does not reopen a stored project during post-auth handoff", async () => {
    localStorage.setItem(ACTIVE_PROJECT_KEY, "project-small");
    window.history.replaceState({}, "", "/?handoff=chat");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") {
        return createJsonResponse({
          projects: [
            {
              arenaWinnerBranchKey: null,
              arenaWinnerSessionId: null,
              createdAt: "2026-04-01T09:00:00.000Z",
              id: "project-small",
              memoryIds: [],
              sessionCount: 2,
              title: "Small project",
              updatedAt: "2026-04-01T09:00:00.000Z",
            },
          ],
        });
      }

      if (url === "/api/projects/project-small") {
        return createJsonResponse({
          project: {
            arenaWinnerBranchKey: null,
            arenaWinnerSessionId: null,
            createdAt: "2026-04-01T09:00:00.000Z",
            globalContext: "Keep focus",
            id: "project-small",
            memoryIds: [],
            sessionCount: 2,
            sessionIds: ["session-a", "session-b"],
            title: "Small project",
            updatedAt: "2026-04-01T09:00:00.000Z",
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    renderWithSession(
      <ProjectsProvider>
        <ProjectsSnapshot />
      </ProjectsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ready").textContent).toBe("true");
    });

    expect(screen.getByTestId("active-project").textContent).toBe("none");
    expect(localStorage.getItem(ACTIVE_PROJECT_KEY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/projects/project-small", expect.anything());
  });
});
