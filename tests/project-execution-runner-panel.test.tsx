// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProjectCanvasSelection } from "@/components/workspace/project-canvas";
import type { ProjectDocument } from "@/lib/project-documents";
import { ProjectExecutionRunnerPanel } from "@/components/workspace/project-execution-runner-panel";

const { addAgentMock, fetchMock, writeTextMock } = vi.hoisted(() => ({
  addAgentMock: vi.fn(),
  fetchMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock("@/components/assistant-ui/thread-graph-flow/use-codex-agent-runs", () => ({
  useCodexAgentRuns: () => ({
    addAgent: addAgentMock,
    agentNodes: [
      {
        data: {
          agentOutput: "Completed the workload and saved the evidence ledger.",
          agentStatus: "completed",
          kind: "agent-run",
          title: "Baseline rollout",
        },
        id: "agent-run-1",
      },
    ],
  }),
}));

const project: ProjectDocument = {
  accessRole: "owner",
  arenaWinnerBranchKey: null,
  arenaWinnerSessionId: null,
  createdAt: "2026-08-14T00:00:00.000Z",
  globalContext: "",
  id: "project-1",
  map: {
    edges: [],
    nodes: [
      {
        description: "Run the frozen baseline.",
        id: "workload-1",
        nodeType: "workload",
        primarySessionId: "session-1",
        selectedOutput: null,
        sessionIds: ["session-1"],
        status: "ready",
        title: "Baseline rollout",
      },
    ],
    version: 1,
  },
  members: [],
  memoryIds: [],
  sessionCount: 1,
  sessionIds: ["session-1"],
  title: "Agent project",
  updatedAt: "2026-08-14T00:00:00.000Z",
};

const selection: ProjectCanvasSelection = {
  kind: "node",
  label: "Baseline rollout",
  mapNodeId: "workload-1",
  preview: "Run the frozen baseline.",
  role: "workload",
  sessionId: "session-1",
  sessionTitle: "Baseline rollout",
};

describe("ProjectExecutionRunnerPanel", () => {
  beforeEach(() => {
    addAgentMock.mockReset();
    fetchMock.mockReset();
    writeTextMock.mockReset();
    fetchMock.mockResolvedValue(
      Response.json({
        authenticated: true,
        codexRunning: true,
        configured: true,
        hasDefaultWorkspace: false,
        model: "gpt-5.6-luna",
        nextStep: {
          code: "ready",
          detail: "Runner ready.",
          title: "Runner ready",
        },
        ok: true,
        reachable: true,
        tychoImage: "tycho-python-sandbox:0.2",
        tychoReady: true,
        tychoRuntime: "docker",
        tychoStatus: "ready",
        workspaceConfigured: true,
        workspaceCount: 1,
      }),
    );
    writeTextMock.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("copies the managed agent result from an icon button", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });
    render(<ProjectExecutionRunnerPanel project={project} selection={selection} />);

    await user.click(screen.getByRole("button", { name: "Open execution runner" }));
    await user.click(await screen.findByRole("button", { name: "Copy agent result" }));

    expect(writeTextMock).toHaveBeenCalledWith(
      "Completed the workload and saved the evidence ledger.",
    );
    expect(screen.getByRole("button", { name: "Agent result copied" })).not.toBeNull();
  });
});
