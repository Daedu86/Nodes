// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ProjectWorkspace } from "../components/workspace/project-workspace";

const clearActiveProject = vi.fn();
const removeActiveProjectMember = vi.fn();
const saveActiveProjectMember = vi.fn();
const saveActiveProjectPatch = vi.fn(async (patch?: unknown) => patch);
const createMemoryItem = vi.fn();
const deleteMemoryItem = vi.fn();
const selectProject = vi.fn(async () => undefined);

const sampleSession = {
  archived: false,
  artifacts: [],
  contextLinks: [],
  createdAt: "2026-04-21T09:00:00.000Z",
  id: "session-1",
  messageCount: 0,
  snapshot: {
    headId: null,
    messages: [],
  },
  title: "Discovery Session",
  updatedAt: "2026-04-21T09:00:00.000Z",
};

const sampleProject = {
  accessRole: "owner" as const,
  arenaWinnerBranchKey: null,
  arenaWinnerSessionId: null,
  attachedMemoryItems: [],
  createdAt: "2026-04-21T09:00:00.000Z",
  globalContext: "Use concise language across all project outputs.",
  id: "project-1",
  members: [],
  memoryIds: [],
  sessionCount: 1,
  sessionIds: ["session-1"],
  sessions: [sampleSession],
  title: "Alpha Project",
  updatedAt: "2026-04-21T09:00:00.000Z",
};

const projectsContext = {
  activeProject: sampleProject,
  clearActiveProject,
  removeActiveProjectMember,
  saveActiveProjectMember,
  saveActiveProjectPatch,
  selectProject,
};

const persistedSessionsContext = {
  activeSessionId: "session-1",
  sessions: [
    {
      archived: false,
      createdAt: "2026-04-21T09:00:00.000Z",
      id: "session-1",
      messageCount: 0,
      title: "Discovery Session",
      updatedAt: "2026-04-21T09:00:00.000Z",
    },
  ],
};

const reusableMemoryContext = {
  createMemoryItem,
  deleteMemoryItem,
  isReady: true,
  items: [],
};

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        email: "owner@example.com",
        id: "owner-1",
        name: "Owner",
      },
    },
  }),
}));

vi.mock("@/components/context/projects", () => ({
  useProjects: () => projectsContext,
}));

vi.mock("@/components/context/persisted-sessions", () => ({
  usePersistedSessions: () => persistedSessionsContext,
}));

vi.mock("@/components/context/reusable-memory", () => ({
  useReusableMemory: () => reusableMemoryContext,
}));

vi.mock("@/components/workspace/project-canvas", () => ({
  ProjectCanvas: ({
    onSelectionChange,
  }: {
    onSelectionChange?: (selection: {
      kind: "node";
      label: string;
      memoryId: null;
      memoryType: null;
      messageId: null;
      preview: string;
      role: string;
      sessionId: null;
      sessionTitle: null;
    }) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onSelectionChange?.({
            kind: "node",
            label: "Alpha Project Context",
            memoryId: null,
            memoryType: null,
            messageId: null,
            preview: "Use concise language across all project outputs.",
            role: "global-context",
            sessionId: null,
            sessionTitle: null,
          })
        }
      >
        Select global context node
      </button>
    </div>
  ),
}));

vi.mock("@/components/workspace/project-arena", () => ({
  ProjectArena: () => <div>Arena stub</div>,
}));


describe("ProjectWorkspace", () => {
  beforeEach(() => {
    clearActiveProject.mockReset();
    removeActiveProjectMember.mockReset();
    saveActiveProjectMember.mockReset();
    saveActiveProjectPatch.mockClear();
    createMemoryItem.mockReset();
    deleteMemoryItem.mockReset();
    selectProject.mockClear();
  });

  it("refreshes the project canvas from the latest saved project state", async () => {
    const user = userEvent.setup();

    render(<ProjectWorkspace />);

    await user.click(screen.getByRole("button", { name: "Refresh project canvas" }));

    expect(selectProject).toHaveBeenCalledWith("project-1");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a visible context CTA in project overview and returns focus to the editor", async () => {
    const user = userEvent.setup();

    render(<ProjectWorkspace />);

    expect(screen.getByText("Shared context")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Edit context" })).not.toBeNull();
    expect(screen.getAllByText("Use concise language across all project outputs.").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Open Sessions" }));
    await user.click(screen.getByRole("button", { name: "Edit context" }));

    const editor = await screen.findByRole("textbox", { name: "Shared narrative" });
    await waitFor(() => {
      expect(document.activeElement).toBe(editor);
    });
  });

  it("opens the shared context editor when the global context node is selected", async () => {
    const user = userEvent.setup();

    render(<ProjectWorkspace />);

    await user.click(screen.getByRole("button", { name: "Open Sessions" }));
    await user.click(screen.getByRole("button", { name: "Select global context node" }));

    const editor = await screen.findByRole("textbox", { name: "Shared narrative" });
    await waitFor(() => {
      expect(document.activeElement).toBe(editor);
    });
  });
});
