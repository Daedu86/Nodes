import type { SessionArtifact } from "@/lib/session-artifacts";

const MAX_ARTIFACT_CONTEXT_CHARS = 24_000;
const MAX_SINGLE_ARTIFACT_CHARS = 12_000;

export type ProjectExecutionMode = "direct" | "tycho";

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

const TYCHO_EXPERIMENT_INSTRUCTIONS = `Execution policy: Tycho empirical harness with Luna/Codex as the actor.

Before treating a candidate as successful, use Tycho's generic experiment harness as the deterministic promotion gate:
1. State one falsifiable hypothesis, the expected observation, explicit falsifiers, the experiment budget, and the promotion checks before seeing the result.
2. Put experiment code in a Python file inside the repository (normally under .nodes/). Do not ask Tycho to run shell command strings or arbitrary host executables. The generic harness executes declared Python scripts only through Tycho's network-disabled Docker/Finch sandbox.
3. Write the protocol to .nodes/tycho-experiment.json. Keep every script path and evidence path relative to the repository. Do not place secrets in the protocol or artifacts.
4. Execute exactly:
   tycho-experiment --workspace . --protocol .nodes/tycho-experiment.json --result .nodes/tycho-result.json
5. Read .nodes/tycho-result.json. A candidate may be promoted only when decision == "promote". "reject" means the hypothesis was falsified under its predeclared gate. "blocked" means execution/infrastructure evidence is incomplete.
6. Preserve the protocol, result, metrics, and useful experiment code as workload evidence. Never overwrite a failed protocol/result to make it look successful; a revision must use a new experimentId and preserve the previous evidence.
7. You may make at most one evidence-driven revision inside this workload after a reject/blocked result. Broader search belongs in a new Nodes iteration/workload so the project map keeps the causal history.

Scientific-integrity constraints: do not use hidden/derived test labels, recovered answer lists, leaderboard subset probing, or change a promotion threshold after observing the candidate result. Kaggle/public external scores are downstream evidence, not training labels.`;

export const buildProjectExecutionPrompt = ({
  projectId,
  projectTitle,
  workloadTitle,
  workloadDescription,
  upstreamSummary,
  artifacts,
  mode = "tycho",
}: {
  projectId: string;
  projectTitle: string;
  workloadTitle: string;
  workloadDescription?: string | null;
  upstreamSummary?: string | null;
  artifacts: SessionArtifact[];
  mode?: ProjectExecutionMode;
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
    mode === "tycho" ? TYCHO_EXPERIMENT_INSTRUCTIONS : "Execution policy: direct Luna/Codex workload execution.",
    "Treat the primary-session artifacts/runbooks as authoritative execution instructions for this workload. Use the repository/workspace as the source of truth. Preserve useful outputs as files/artifacts and report what was executed, verified, and what remains blocked. Do not expose local credentials or authentication files.",
  ]
    .filter(Boolean)
    .join("\n\n");
};
