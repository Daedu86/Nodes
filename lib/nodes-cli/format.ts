import type {
  NodesArtifact,
  NodesProject,
  NodesProjectDiagnosis,
  NodesProjectMap,
  NodesProjectSummary,
  NodesRunner,
  NodesSession,
  NodesTycho,
  NodesWorkload,
  NodesWorkloadInspection,
} from "@/lib/nodes-cli/types";

const yesNo = (value: boolean) => value ? "yes" : "no";
const yesNoUnknown = (value: boolean | null) => value === null ? "unknown" : yesNo(value);
const valueOrNone = (value: string | null | undefined) => value || "none";
const titleOrId = (project: Pick<NodesProject, "id" | "title">) => project.title ?? project.id;

const indentLines = (value: string, indentation = "  ") =>
  value.split("\n").map((line) => `${indentation}${line}`).join("\n");

const formatProjectHeader = (project: NodesProject) => [
  "Project",
  `  ${titleOrId(project)}`,
  `  id: ${project.id}`,
  `  accessRole: ${project.accessRole}`,
].join("\n");

export const formatProjectList = (projects: NodesProjectSummary[]) => {
  if (projects.length === 0) return "No projects found.";
  return [
    "Projects",
    ...projects.flatMap((project) => [
      `  ${project.title ?? "Untitled project"}`,
      `    id: ${project.id}`,
      `    accessRole: ${project.accessRole} · sessions: ${project.sessionCount} · updated: ${project.updatedAt}`,
    ]),
  ].join("\n");
};

export const formatProject = (project: NodesProject) => [
  formatProjectHeader(project),
  "",
  "State",
  `  workloads: ${project.workloadCount}`,
  `  sessions: ${project.sessionCount}`,
  `  memories: ${project.memoryCount}`,
  `  globalContextPresent: ${yesNo(project.globalContextPresent)}`,
  `  created: ${project.createdAt}`,
  `  updated: ${project.updatedAt}`,
].join("\n");

const formatWorkloadLine = (workload: NodesWorkload) => [
  `  ${workload.title}`,
  `    id: ${workload.id}`,
  `    status: ${workload.status} · sessions: ${workload.sessionIds.length} · primary: ${valueOrNone(workload.primarySessionId)}`,
].join("\n");

export const formatWorkloadList = (
  project: NodesProject,
  workloads: NodesWorkload[],
) => [
  formatProjectHeader(project),
  "",
  "Workloads",
  workloads.length > 0
    ? workloads.map(formatWorkloadLine).join("\n")
    : "  none",
].join("\n");

export const formatProjectMap = (map: NodesProjectMap) => [
  formatWorkloadList(map.project, map.workloads),
  "",
  "Dependencies",
  map.edges.length > 0
    ? map.edges.map((edge) =>
        `  ${edge.sourceWorkloadId} -> ${edge.targetWorkloadId}${edge.label ? ` (${edge.label})` : ""}`,
      ).join("\n")
    : "  none",
].join("\n");

const formatArtifactLine = (artifact: NodesArtifact) =>
  `  ${artifact.fileName ?? artifact.title} · ${artifact.artifactType}${artifact.semanticType ? `/${artifact.semanticType}` : ""} · id: ${artifact.id}`;

export const formatArtifacts = (artifacts: NodesArtifact[]) => [
  "Artifacts",
  artifacts.length > 0
    ? artifacts.map(formatArtifactLine).join("\n")
    : "  none",
].join("\n");

export const formatSession = (session: NodesSession) => [
  "Session",
  `  ${session.title ?? "Untitled session"}`,
  `  id: ${session.id}`,
  `  archived: ${yesNo(session.archived)} · version: ${session.version} · messages: ${session.messageCount}`,
  `  created: ${session.createdAt}`,
  `  updated: ${session.updatedAt}`,
  "",
  "Project/workload associations",
  session.associations.length > 0
    ? session.associations.map((association) =>
        `  ${association.projectTitle ?? association.projectId} / ${association.workloadTitle}${association.isPrimary ? " (primary)" : ""}`,
      ).join("\n")
    : "  none resolved",
  "",
  formatArtifacts(session.artifacts),
  "",
  "Selected outputs",
  session.selectedOutputs.length > 0
    ? session.selectedOutputs.map((reference) =>
        `  ${reference.workloadTitle}: ${reference.output.summary || "selected output with no summary"}`,
      ).join("\n")
    : "  none",
  "",
  "Codex snapshot",
  `  updated: ${valueOrNone(session.codex.snapshotUpdatedAt)}`,
  `  runs: ${session.codex.runs.length}`,
  ...session.codex.runs.map((run) =>
    `    ${run.label} · ${run.status} · run: ${valueOrNone(run.runId)}`),
].join("\n");

export const formatRunner = (runner: NodesRunner) => [
  "Runner",
  `  online: ${yesNo(runner.online)}`,
  `  configured: ${yesNo(runner.configured)}`,
  `  codexRunning: ${yesNo(runner.codexRunning)}`,
  `  codexAuthenticated: ${yesNo(runner.codexAuthenticated)}`,
  `  workspaceMapped: ${yesNo(runner.workspaceMapped)}`,
  `  workspaceKey: ${runner.workspaceKey}`,
  `  ready: ${yesNo(runner.ready)}`,
  `  model: ${valueOrNone(runner.model)}`,
  `  reason: ${runner.reason}`,
].join("\n");

export const formatTycho = (tycho: NodesTycho) => [
  "Tycho",
  `  requiredForWorkload: ${yesNo(tycho.requiredForWorkload)}`,
  `  reportedByRunner: ${yesNo(tycho.reportedByRunner)}`,
  `  ready: ${yesNoUnknown(tycho.ready)}`,
  `  runtime: ${valueOrNone(tycho.runtime)}`,
  `  image: ${valueOrNone(tycho.image)}`,
  `  authoritativeProtocolPresent: ${yesNo(tycho.authoritativeProtocolPresent)}`,
  `  filesystemProtocolPresent: ${yesNoUnknown(tycho.filesystemProtocolPresent)}`,
  `  authoritativeExperimentPresent: ${yesNo(tycho.authoritativeExperimentPresent)}`,
  `  filesystemExperimentPresent: ${yesNoUnknown(tycho.filesystemExperimentPresent)}`,
  `  authoritativeResultPresent: ${yesNo(tycho.authoritativeResultPresent)}`,
  `  filesystemResultPresent: ${yesNoUnknown(tycho.filesystemResultPresent)}`,
  `  currentDecision: ${valueOrNone(tycho.currentDecision)}`,
  "",
  "Known Tycho blockers",
  tycho.knownBlockers.length > 0
    ? tycho.knownBlockers.map((blocker) => `  - ${blocker.message} [${blocker.code}]`).join("\n")
    : "  none",
].join("\n");

const formatExecution = (inspection: Pick<NodesWorkloadInspection, "execution">) => [
  "Execution",
  `  runnable: ${yesNo(inspection.execution.runnable)}`,
  "",
  "Blockers",
  inspection.execution.blockers.length > 0
    ? inspection.execution.blockers.map((blocker) =>
        `  - ${blocker.message} [${blocker.code}]`).join("\n")
    : "  none",
].join("\n");

export const formatWorkloadInspection = (inspection: NodesWorkloadInspection) => [
  formatProjectHeader(inspection.project),
  "",
  "Workload",
  `  ${inspection.workload.title}`,
  `  id: ${inspection.workload.id}`,
  `  status: ${inspection.workload.status}`,
  `  primarySessionId: ${valueOrNone(inspection.workload.primarySessionId)}`,
  `  sessionIds: ${inspection.workload.sessionIds.join(", ") || "none"}`,
  `  selectedOutput: ${inspection.workload.selectedOutput?.summary || "none"}`,
  "",
  "Upstream dependencies",
  inspection.upstream.length > 0
    ? inspection.upstream.map((entry) => [
        `  ${entry.workload.title}`,
        `    selectedOutput: ${entry.selectedOutput?.summary || "none"}`,
        `    selectedArtifacts: ${entry.artifacts.map((artifact) => artifact.fileName ?? artifact.title).join(", ") || "none"}`,
      ].join("\n")).join("\n")
    : "  none",
  "",
  formatArtifacts(inspection.artifacts),
  "",
  formatRunner(inspection.runner),
  "",
  formatTycho(inspection.tycho),
  "",
  formatExecution(inspection),
].join("\n");

export const formatProjectDiagnosis = (diagnosis: NodesProjectDiagnosis) => {
  const workload = diagnosis.workload;
  const otherSessions = diagnosis.sessions.filter((session) =>
    session.id !== diagnosis.primarySession?.id);
  return [
    formatProjectHeader(diagnosis.project),
    "",
    "Current workload",
    workload
      ? `  ${workload.title}\n  id: ${workload.id}\n  status: ${workload.status}\n  selection: ${diagnosis.workloadSelection.reason}`
      : `  none\n  selection: ${diagnosis.workloadSelection.reason}`,
    "",
    "Primary session",
    diagnosis.primarySession
      ? `  ${diagnosis.primarySession.id}${diagnosis.primarySession.title ? ` — ${diagnosis.primarySession.title}` : ""}`
      : `  ${valueOrNone(workload?.primarySessionId)}`,
    "",
    "Other workload sessions",
    otherSessions.length > 0
      ? otherSessions.map((session) => `  ${session.id}${session.title ? ` — ${session.title}` : ""}`).join("\n")
      : "  none",
    "",
    "Selected upstream outputs",
    diagnosis.upstream.some((entry) => entry.selectedOutput)
      ? diagnosis.upstream.flatMap((entry) => entry.selectedOutput
          ? [`  ${entry.workload.title}\n${indentLines(entry.selectedOutput.summary || "(no summary)", "    ")}`]
          : []).join("\n")
      : "  none",
    "",
    "Authoritative execution artifacts",
    ...diagnosis.authoritativeArtifacts.map((artifact) =>
      `  ${artifact.path.padEnd(34)} ${artifact.present ? "PRESENT" : "MISSING"}`),
    "",
    formatRunner(diagnosis.runner),
    "",
    formatTycho(diagnosis.tycho),
    "",
    formatExecution(diagnosis),
  ].join("\n");
};
