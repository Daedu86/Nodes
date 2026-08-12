import { describe, expect, it } from "vitest";

import {
  buildSessionWorkspaceFiles,
  hasTychoProtocolWorkspaceFile,
} from "@/lib/agents/codex/session-workspace-files";
import type { SessionArtifact } from "@/lib/session-artifacts";

const artifact = (
  overrides: Partial<SessionArtifact> = {},
): SessionArtifact => ({
  id: "artifact-1",
  title: "Execution file",
  artifactType: "code",
  content: "print('ok')\n",
  fileName: ".nodes/experiment.py",
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
  ...overrides,
});

describe("buildSessionWorkspaceFiles", () => {
  it("materializes only explicitly scoped .nodes files", () => {
    const files = buildSessionWorkspaceFiles([
      artifact(),
      artifact({ id: "ignored", fileName: "README.md", content: "ignore" }),
    ]);

    expect(files).toEqual([
      expect.objectContaining({
        artifactId: "artifact-1",
        path: ".nodes/experiment.py",
        content: "print('ok')\n",
      }),
    ]);
  });

  it("rejects conflicting artifacts for the same workspace path", () => {
    expect(() =>
      buildSessionWorkspaceFiles([
        artifact(),
        artifact({ id: "artifact-2", content: "print('different')\n" }),
      ]),
    ).toThrow(/Conflicting primary-session artifacts/);
  });

  it("recognizes the frozen Tycho protocol", () => {
    const files = buildSessionWorkspaceFiles([
      artifact({
        fileName: ".nodes/tycho-experiment.json",
        content: "{}\n",
      }),
    ]);
    expect(hasTychoProtocolWorkspaceFile(files)).toBe(true);
  });
});
