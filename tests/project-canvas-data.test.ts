import { describe, expect, it } from "vitest";
import { buildProjectCanvasFlow } from "@/components/workspace/project-canvas-data";
import type { ProjectDocument } from "@/lib/project-documents";
import type { ProjectMemoryItem } from "@/lib/memory-documents";

const project: ProjectDocument = {
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
      description: "Compare the source sessions.",
      id: "workload-1",
      nodeType: "workload",
      primarySessionId: "session-1",
      selectedOutput: null,
      sessionIds: ["session-1"],
      status: "ready",
      terminalResult: false,
      title: "Project setup",
    }],
    version: 1,
  },
  members: [],
  memoryIds: ["memory-attached"],
  sessionCount: 1,
  sessionIds: ["session-1"],
  title: "Project",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

const memoryItem = (id: string): ProjectMemoryItem => ({
  content: "Merged evidence from both branches.",
  createdAt: "2026-08-13T00:00:00.000Z",
  id,
  sourceKeys: ["session-1:root-a", "session-1:root-b"],
  sourceKind: "branch",
  sourceProjectId: project.id,
  sourceSessionId: "session-1",
  title: "Lead branch merge node",
  type: "merge",
  updatedAt: "2026-08-13T00:00:00.000Z",
});

describe("buildProjectCanvasFlow", () => {
  it("projects attached typed nodes onto the canvas with their source edge", () => {
    const attached = memoryItem("memory-attached");
    const flow = buildProjectCanvasFlow(project, [], [
      attached,
      memoryItem("memory-unattached"),
    ]);

    expect(flow.nodes).toHaveLength(2);
    expect(flow.nodes.find((node) => node.data.memoryId === attached.id)).toMatchObject({
      data: {
        memoryType: "merge",
        preview: attached.content,
        role: "memory",
        statusLabel: "Merge",
        title: attached.title,
      },
      id: `project:${project.id}:memory:${attached.id}`,
      type: "artifactNode",
    });
    expect(flow.nodes.some((node) => node.data.memoryId === "memory-unattached")).toBe(false);
    expect(flow.edges).toContainEqual(expect.objectContaining({
      source: `project:${project.id}:workload:workload-1`,
      target: `project:${project.id}:memory:${attached.id}`,
    }));
  });
});
