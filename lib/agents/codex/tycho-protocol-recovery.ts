import type { SessionArtifact } from "@/lib/session-artifacts";

export const TYCHO_PROTOCOL_PATH = ".nodes/tycho-experiment.json";

export type TychoProtocolRecoverySource = {
  sessionId: string;
  artifacts: SessionArtifact[];
};

export type TychoProtocolRecovery = {
  content: string;
  sourceArtifactIds: string[];
  sourceSessionIds: string[];
};

export class TychoProtocolRecoveryConflictError extends Error {
  constructor() {
    super("Conflicting Tycho protocols exist across workload sessions; recovery requires one unique authoritative protocol.");
    this.name = "TychoProtocolRecoveryConflictError";
  }
}

const getProtocolArtifacts = (source: TychoProtocolRecoverySource) =>
  source.artifacts
    .filter(
      (artifact) =>
        artifact.fileName === TYCHO_PROTOCOL_PATH && artifact.content.trim().length > 0,
    )
    .map((artifact) => ({ artifact, sessionId: source.sessionId }));

export const recoverUniqueTychoProtocol = (
  sources: TychoProtocolRecoverySource[],
): TychoProtocolRecovery | null => {
  const candidates = sources.flatMap(getProtocolArtifacts);
  if (candidates.length === 0) return null;

  const byContent = new Map<
    string,
    { sourceArtifactIds: Set<string>; sourceSessionIds: Set<string> }
  >();

  for (const candidate of candidates) {
    const existing = byContent.get(candidate.artifact.content) ?? {
      sourceArtifactIds: new Set<string>(),
      sourceSessionIds: new Set<string>(),
    };
    existing.sourceArtifactIds.add(candidate.artifact.id);
    existing.sourceSessionIds.add(candidate.sessionId);
    byContent.set(candidate.artifact.content, existing);
  }

  if (byContent.size !== 1) {
    throw new TychoProtocolRecoveryConflictError();
  }

  const [[content, provenance]] = [...byContent.entries()];
  return {
    content,
    sourceArtifactIds: [...provenance.sourceArtifactIds].sort(),
    sourceSessionIds: [...provenance.sourceSessionIds].sort(),
  };
};

export const createRecoveredTychoProtocolArtifact = ({
  content,
  now = new Date().toISOString(),
}: {
  content: string;
  now?: string;
}): SessionArtifact => ({
  id: crypto.randomUUID(),
  title: "Tycho experiment protocol (recovered)",
  artifactType: "file",
  semanticType: "evidence",
  content,
  fileName: TYCHO_PROTOCOL_PATH,
  language: "json",
  mimeType: "application/json",
  createdAt: now,
  updatedAt: now,
});
