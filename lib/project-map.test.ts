import { describe, expect, it } from "vitest";
import {
  buildProjectMapInputSummary,
  filterProjectMapSessions,
  getProjectMapSessionIds,
  normalizeProjectMap,
  wouldCreateProjectMapCycle,
} from "@/lib/project-map";

describe("project map", () => {
  it("normalizes workload nodes and dependency edges", () => {
    const map = normalizeProjectMap({
      version: 99,
      nodes: [
        {
          id: "inspect",
          title: "Dataset inspection",
          sessionIds: ["s1", "s1"],
          primarySessionId: "s1",
          status: "complete",
          selectedOutput: {
            sessionId: "s1",
            messageId: "m1",
            summary: "Missing Age values identified.",
          },
        },
        {
          id: "prep",
          title: "Shared preprocessing",
          sessionIds: ["s2"],
          status: "ready",
        },
      ],
      edges: [
        {
          id: "inspect-prep",
          sourceNodeId: "inspect",
          targetNodeId: "prep",
          label: "data quality output",
        },
      ],
    });

    expect(map.version).toBe(1);
    expect(map.nodes).toHaveLength(2);
    expect(map.nodes[0]?.sessionIds).toEqual(["s1"]);
    expect(map.edges).toEqual([
      {
        id: "inspect-prep",
        sourceNodeId: "inspect",
        targetNodeId: "prep",
        label: "data quality output",
      },
    ]);
    expect(getProjectMapSessionIds(map)).toEqual(["s1", "s2"]);
  });

  it("removes sessions the project owner cannot attach", () => {
    const map = filterProjectMapSessions(
      {
        nodes: [
          {
            id: "model",
            title: "Random forest",
            sessionIds: ["allowed", "forbidden"],
            primarySessionId: "forbidden",
            selectedOutput: {
              sessionId: "forbidden",
              summary: "Should be removed",
            },
          },
        ],
        edges: [],
      },
      new Set(["allowed"]),
    );

    expect(map.nodes[0]?.sessionIds).toEqual(["allowed"]);
    expect(map.nodes[0]?.primarySessionId).toBe("allowed");
    expect(map.nodes[0]?.selectedOutput).toBeNull();
  });

  it("gives a session to only one workload", () => {
    const map = normalizeProjectMap({
      nodes: [
        { id: "first", title: "First", sessionIds: ["shared"] },
        { id: "second", title: "Second", sessionIds: ["shared", "own"] },
      ],
      edges: [],
    });

    expect(map.nodes[0]?.sessionIds).toEqual(["shared"]);
    expect(map.nodes[1]?.sessionIds).toEqual(["own"]);
  });

  it("rejects circular dependencies", () => {
    const map = normalizeProjectMap({
      nodes: [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
        { id: "c", title: "C" },
      ],
      edges: [
        { sourceNodeId: "a", targetNodeId: "b" },
        { sourceNodeId: "b", targetNodeId: "c" },
        { sourceNodeId: "c", targetNodeId: "a" },
      ],
    });

    expect(map.edges).toHaveLength(2);
    expect(wouldCreateProjectMapCycle(map, "c", "a")).toBe(true);
  });

  it("builds downstream input from selected upstream outputs only", () => {
    const map = normalizeProjectMap({
      nodes: [
        {
          id: "inspect",
          title: "Dataset inspection",
          sessionIds: ["s1"],
          selectedOutput: {
            sessionId: "s1",
            messageId: "m1",
            summary: "Age needs imputation.",
          },
        },
        {
          id: "prep",
          title: "Preprocessing",
          sessionIds: ["s2"],
        },
        {
          id: "unrelated",
          title: "Unrelated",
          sessionIds: ["s3"],
          selectedOutput: {
            sessionId: "s3",
            summary: "Do not include me.",
          },
        },
      ],
      edges: [
        { sourceNodeId: "inspect", targetNodeId: "prep" },
      ],
    });

    const input = buildProjectMapInputSummary(map, "prep");
    expect(input).toContain("Dataset inspection");
    expect(input).toContain("Age needs imputation.");
    expect(input).not.toContain("Unrelated");
  });
});
