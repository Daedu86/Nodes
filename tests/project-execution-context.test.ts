import { describe, expect, it } from "vitest";
import {
  buildProjectExecutionPrompt,
  buildSessionArtifactExecutionContext,
} from "@/lib/agents/codex/project-execution-context";
import type { SessionArtifact } from "@/lib/session-artifacts";

const artifact = (overrides: Partial<SessionArtifact> = {}): SessionArtifact => ({
  id: "artifact-1",
  title: "Execution Runbook",
  artifactType: "file",
  semanticType: "evidence",
  blobRef: null,
  byteSize: 12,
  content: "run exactly these three tasks",
  fileName: "runbook.md",
  language: "markdown",
  mimeType: "text/markdown",
  position: null,
  sourceDataUrl: null,
  promptStatus: null,
  promptResult: null,
  promptError: null,
  promptRunId: null,
  promptModel: null,
  promptProvider: null,
  promptStartedAt: null,
  promptCompletedAt: null,
  syncMode: "auto",
  revisions: [],
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
  ...overrides,
});

describe("project execution context", () => {
  it("includes textual primary-session artifacts and metadata", () => {
    const context = buildSessionArtifactExecutionContext([artifact()]);
    expect(context).toContain("### Execution Runbook");
    expect(context).toContain("file: runbook.md");
    expect(context).toContain("semantic type: evidence");
    expect(context).toContain("run exactly these three tasks");
  });

  it("does not inject image artifacts into the execution prompt", () => {
    const context = buildSessionArtifactExecutionContext([
      artifact({ artifactType: "image", content: "data:image/png;base64,secret" }),
    ]);
    expect(context).toBe("");
  });

  it("builds a workload prompt with upstream outputs and the attached runbook", () => {
    const prompt = buildProjectExecutionPrompt({
      projectId: "project-1",
      projectTitle: "BenchFlow",
      workloadTitle: "No-Skill Baseline",
      workloadDescription: "Run the frozen baseline.",
      upstreamSummary: "Node 03 observation contract",
      artifacts: [artifact({ content: "tictoc-unnecessary-abort-detection\nxlsx-recover-data\ndata-to-d3" })],
    });

    expect(prompt).toContain("Project id: project-1");
    expect(prompt).toContain("Node 03 observation contract");
    expect(prompt).toContain("Primary-session artifacts / runbooks:");
    expect(prompt).toContain("tictoc-unnecessary-abort-detection");
    expect(prompt).toContain("xlsx-recover-data");
    expect(prompt).toContain("data-to-d3");
    expect(prompt).toContain("authoritative execution instructions");
  });

  it("bounds oversized artifact content", () => {
    const context = buildSessionArtifactExecutionContext([
      artifact({ content: "x".repeat(40_000) }),
    ]);
    expect(context.length).toBeLessThan(25_000);
    expect(context).toContain("[artifact truncated]");
  });
});
