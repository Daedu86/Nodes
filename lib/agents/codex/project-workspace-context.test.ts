import { describe, expect, it } from "vitest";

import { getSelectedAncestorArtifactRefs } from "@/lib/agents/codex/project-workspace-context";
import { normalizeProjectMap } from "@/lib/project-map";

describe("getSelectedAncestorArtifactRefs", () => {
  it("collects selected artifacts from all transitive ancestors", () => {
    const map = normalizeProjectMap({
      version: 1,
      nodes: [
        {
          id: "protocol",
          title: "Protocol",
          description: "",
          status: "complete",
          sessionIds: ["session-protocol"],
          primarySessionId: "session-protocol",
          selectedOutput: {
            sessionId: "session-protocol",
            artifactIds: ["protocol-json", "protocol-script"],
            messageId: null,
            summary: "Frozen protocol",
            updatedAt: null,
          },
        },
        {
          id: "readiness",
          title: "Readiness",
          description: "",
          status: "complete",
          sessionIds: ["session-readiness"],
          primarySessionId: "session-readiness",
          selectedOutput: {
            sessionId: "session-readiness",
            artifactIds: ["doctor-receipt"],
            messageId: null,
            summary: "Docker ready",
            updatedAt: null,
          },
        },
        {
          id: "run",
          title: "Run",
          description: "",
          status: "ready",
          sessionIds: ["session-run"],
          primarySessionId: "session-run",
          selectedOutput: null,
        },
        {
          id: "unrelated",
          title: "Unrelated",
          description: "",
          status: "complete",
          sessionIds: ["session-unrelated"],
          primarySessionId: "session-unrelated",
          selectedOutput: {
            sessionId: "session-unrelated",
            artifactIds: ["unrelated-artifact"],
            messageId: null,
            summary: "Not upstream",
            updatedAt: null,
          },
        },
      ],
      edges: [
        { id: "e1", sourceNodeId: "protocol", targetNodeId: "readiness" },
        { id: "e2", sourceNodeId: "readiness", targetNodeId: "run" },
      ],
    });

    expect(getSelectedAncestorArtifactRefs(map, "run")).toEqual([
      {
        artifactIds: ["protocol-json", "protocol-script"],
        nodeId: "protocol",
        sessionId: "session-protocol",
      },
      {
        artifactIds: ["doctor-receipt"],
        nodeId: "readiness",
        sessionId: "session-readiness",
      },
    ]);
  });

  it("returns no artifacts when the target has no ancestors", () => {
    const map = normalizeProjectMap({
      version: 1,
      nodes: [
        {
          id: "run",
          title: "Run",
          description: "",
          status: "ready",
          sessionIds: ["session-run"],
          primarySessionId: "session-run",
          selectedOutput: null,
        },
      ],
      edges: [],
    });

    expect(getSelectedAncestorArtifactRefs(map, "run")).toEqual([]);
  });
});
