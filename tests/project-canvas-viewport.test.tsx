// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDocument } from "@/lib/project-documents";

const flowState = vi.hoisted(() => ({
  fitView: vi.fn(),
  mounts: 0,
  unmounts: 0,
}));

vi.mock("@xyflow/react", async () => {
  const ReactModule = await import("react");
  const reactFlowApi = { fitView: flowState.fitView };

  return {
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    Controls: () => null,
    Handle: () => null,
    MiniMap: () => null,
    Position: { Left: "left", Right: "right" },
    ReactFlow: ({ children }: { children?: React.ReactNode }) => {
      ReactModule.useEffect(() => {
        flowState.mounts += 1;
        return () => {
          flowState.unmounts += 1;
        };
      }, []);
      return <div data-testid="react-flow">{children}</div>;
    },
    ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useReactFlow: () => reactFlowApi,
  };
});

vi.mock("@/components/context/persisted-sessions", () => ({
  usePersistedSessions: () => ({ sessions: [] }),
}));

vi.mock("@/components/context/projects", () => ({
  useProjects: () => ({
    clearActiveProject: vi.fn(),
    saveActiveProjectPatch: vi.fn(),
  }),
}));

import { ProjectCanvas } from "@/components/workspace/project-canvas";

const makeProject = (status: "ready" | "complete"): ProjectDocument => ({
  accessRole: "owner",
  arenaWinnerBranchKey: null,
  arenaWinnerSessionId: null,
  createdAt: "2026-08-13T00:00:00.000Z",
  globalContext: "",
  id: "project-1",
  map: {
    edges: [],
    nodes: [{
      childProjectId: null,
      description: "Keep the current viewport while refreshing this workload.",
      id: "workload-1",
      nodeType: "workload",
      primarySessionId: null,
      selectedOutput: null,
      sessionIds: [],
      status,
      terminalResult: false,
      title: "Viewport regression",
    }],
    version: 1,
  },
  members: [],
  memoryIds: [],
  sessionCount: 0,
  sessionIds: [],
  title: "Project",
  updatedAt: status === "ready"
    ? "2026-08-13T00:00:00.000Z"
    : "2026-08-13T00:01:00.000Z",
});

describe("ProjectCanvas viewport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    flowState.fitView.mockReset();
    flowState.mounts = 0;
    flowState.unmounts = 0;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("preserves the React Flow instance when refreshed map data changes", async () => {
    const { rerender } = render(
      <ProjectCanvas project={makeProject("ready")} sessions={[]} memoryItems={[]} />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(flowState.mounts).toBe(1);
    expect(flowState.fitView).toHaveBeenCalledTimes(1);

    rerender(
      <ProjectCanvas project={makeProject("complete")} sessions={[]} memoryItems={[]} />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(flowState.mounts).toBe(1);
    expect(flowState.unmounts).toBe(0);
    expect(flowState.fitView).toHaveBeenCalledTimes(1);
  });
});
