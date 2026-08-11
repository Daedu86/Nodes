import type { SessionArtifact } from "@/lib/session-artifacts";

const MAX_ARTIFACT_CONTEXT_CHARS = 24_000;
const MAX_SINGLE_ARTIFACT_CHARS = 12_000;

const isTextualArtifact = (artifact: SessionArtifact) =>
  artifact.artifactType !== "image" && artifact.content.trim().length > 0;

const formatArtifact = (artifact: SessionArtifact) => {
  const header = [
    `### ${artifact.title}`,
    artifact.fileName ? `file: ${artifact.fileName}` : "",
    artifact.semanticType ? `semantic type: ${artifact.semanticType}` : "",
    artifact.mimeType ? `mime: ${artifact.mimeType}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const content = artifact.content.slice(0, MAX_SINGLE_ARTIFACT_CHARS);
  const truncated = artifact.content.length > content.length ? "\n[artifact truncated]" : "";
  return `${header}\n\n${content}${truncated}`;
};

export const buildSessionArtifactExecutionContext = (artifacts: SessionArtifact[]) => {
  const sections: string[] = [];
  let used = 0;

  for (const artifact of artifacts) {
    if (!isTextualArtifact(artifact)) continue;
    const formatted = formatArtifact(artifact);
    const remaining = MAX_ARTIFACT_CONTEXT_CHARS - used;
    if (remaining <= 0) break;
    const included = formatted.slice(0, remaining);
    sections.push(included);
    used += included.length;
    if (included.length < formatted.length) {
      sections.push("[session artifact context truncated]");
      break;
    }
  }

  return sections.join("\n\n");
};

export const buildProjectExecutionPrompt = ({
  projectId,
  projectTitle,
  workloadTitle,
  workloadDescription,
  upstreamSummary,
  artifacts,
}: {
  projectId: string;
  projectTitle: string;
  workloadTitle: string;
  workloadDescription?: string | null;
  upstreamSummary?: string | null;
  artifacts: SessionArtifact[];
}) => {
  const artifactContext = buildSessionArtifactExecutionContext(artifacts);
  return [
    "Execute this Nodes project workload in the configured project workspace.",
    `Project: ${projectTitle || projectId}`,
    `Project id: ${projectId}`,
    `Workload: ${workloadTitle}`,
    workloadDescription ? `Objective: ${workloadDescription}` : "",
    upstreamSummary ? `Selected upstream outputs:\n${upstreamSummary}` : "",
    artifactContext ? `Primary-session artifacts / runbooks:\n${artifactContext}` : "",
    "Treat the primary-session artifacts/runbooks as authoritative execution instructions for this workload. Use the repository/workspace as the source of truth. Preserve useful outputs as files/artifacts and report what was executed, verified, and what remains blocked. Do not expose local credentials or authentication files.",
  ]
    .filter(Boolean)
    .join("\n\n");
};
