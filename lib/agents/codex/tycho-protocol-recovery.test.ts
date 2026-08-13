import { describe, expect, it, vi } from "vitest";
import type { SessionArtifact } from "@/lib/session-artifacts";
import {
  createRecoveredTychoProtocolArtifact,
  recoverUniqueTychoProtocol,
  TychoProtocolRecoveryConflictError,
} from "@/lib/agents/codex/tycho-protocol-recovery";

const artifact = (id: string, content: string, fileName = ".nodes/tycho-experiment.json"): SessionArtifact => ({
  id,
  title: id,
  artifactType: "file",
  content,
  fileName,
  createdAt: "2026-08-13T09:00:00.000Z",
  updatedAt: "2026-08-13T09:00:00.000Z",
});

describe("recoverUniqueTychoProtocol", () => {
  it("returns null when no preserved protocol exists", () => {
    expect(
      recoverUniqueTychoProtocol([
        { sessionId: "s1", artifacts: [artifact("a1", "{}", ".nodes/other.json")] },
      ]),
    ).toBeNull();
  });

  it("recovers one unique protocol and preserves provenance", () => {
    const content = '{"schemaVersion":1,"experimentId":"frozen-001"}';
    expect(
      recoverUniqueTychoProtocol([
        { sessionId: "s2", artifacts: [artifact("a2", content)] },
        { sessionId: "s1", artifacts: [artifact("a1", content)] },
      ]),
    ).toEqual({
      content,
      sourceArtifactIds: ["a1", "a2"],
      sourceSessionIds: ["s1", "s2"],
    });
  });

  it("fails closed when workload sessions contain conflicting protocols", () => {
    expect(() =>
      recoverUniqueTychoProtocol([
        { sessionId: "s1", artifacts: [artifact("a1", '{"experimentId":"one"}')] },
        { sessionId: "s2", artifacts: [artifact("a2", '{"experimentId":"two"}')] },
      ]),
    ).toThrow(TychoProtocolRecoveryConflictError);
  });
});

describe("createRecoveredTychoProtocolArtifact", () => {
  it("creates an authoritative .nodes artifact without altering content", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "recovered-id" });
    const content = '{"schemaVersion":1}';
    const recovered = createRecoveredTychoProtocolArtifact({
      content,
      now: "2026-08-13T09:10:00.000Z",
    });
    expect(recovered).toMatchObject({
      id: "recovered-id",
      fileName: ".nodes/tycho-experiment.json",
      content,
      artifactType: "file",
      semanticType: "evidence",
      mimeType: "application/json",
    });
    vi.unstubAllGlobals();
  });
});
