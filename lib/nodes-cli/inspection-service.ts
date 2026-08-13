import type { AgentWorkRepository } from "@/lib/persistence/agent-work-repository";
import type {
  ProjectActor,
  ProjectRecord,
  ProjectRepository,
} from "@/lib/persistence/project-repository";
import { getAgentWorkRepository, getProjectRepository, getSessionRepository } from "@/lib/persistence/repositories";
import type { SessionRepository } from "@/lib/persistence/session-repository";
import type { ProjectSummary } from "@/lib/project-documents";
import {
  getProjectMapUpstreamNodes,
  normalizeProjectMap,
  type ProjectMap,
  type ProjectMapNode,
} from "@/lib/project-map";
import type { SessionDocument } from "@/lib/session-documents";
import type { SessionArtifact } from "@/lib/session-artifacts";
import {
  getCodexProjectRunnerStatus,
  type CodexProjectRunnerStatus,
} from "@/lib/agents/codex/runner-status";
import {
  NODES_CLI_SCHEMA_VERSION,
  type NodesArtifact,
  type NodesCodexRun,
  type NodesExecution,
  type NodesExecutionArtifact,
  type NodesExecutionBlocker,
  type NodesProject,
  type NodesProjectDiagnosis,
  type NodesProjectMap,
  type NodesProjectSummary,
  type NodesRunner,
  type NodesSelectedOutput,
  type NodesSession,
  type NodesSessionAssociation,
  type NodesTycho,
  type NodesUpstream,
  type NodesWorkload,
  type NodesWorkloadInspection,
} from "@/lib/nodes-cli/types";

const TYCHO_PROTOCOL_PATH = ".nodes/tycho-experiment.json";
const TYCHO_EXPERIMENT_PATH = ".nodes/experiment.py";
const TYCHO_RESULT_PATHS = new Set([
  ".nodes/tycho-result.json",
  ".nodes/tycho-experiment-result.json",
]);
const SAFE_RESOURCE_ID = /^[a-zA-Z0-9_-]{1,200}$/u;

export class NodesResourceNotFoundError extends Error {}
export class NodesAmbiguousResourceError extends Error {}
export class NodesInvalidResourceError extends Error {}

export type NodesRunnerStatusLoader = (input: {
  ownerId: string;
  workspaceId: string | null;
}) => Promise<CodexProjectRunnerStatus>;

export type NodesInspectionServiceOptions = {
  actor: ProjectActor;
  agentWorkRepository?: AgentWorkRepository;
  projectRepository?: ProjectRepository;
  runnerStatusLoader?: NodesRunnerStatusLoader;
  sessionRepository?: SessionRepository;
};

type LoadedProject = {
  map: ProjectMap;
  record: ProjectRecord;
  sessions: Map<string, SessionDocument>;
};

type SessionOutputReference = {
  output: NodesSelectedOutput;
  projectId: string;
  workloadId: string;
  workloadTitle: string;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;

const asString = (value: unknown, maxLength = 500) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : null;

export const redactSensitiveText = (value: string) => {
  let redacted = value;
  redacted = redacted.replace(
    /\b(Bearer)\s+[^\s,;]+/giu,
    "$1 [REDACTED]",
  );
  redacted = redacted.replace(
    /\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*([^\s,;]+)/giu,
    "$1=[REDACTED]",
  );
  redacted = redacted.replace(
    /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu,
    "$1[REDACTED]@",
  );
  redacted = redacted.replace(
    /(^|\s)(\/(?:home|users|srv|var|tmp|opt|mnt|volumes)\/[^\s,;]+)/giu,
    "$1[LOCAL_PATH_REDACTED]",
  );
  redacted = redacted.replace(
    /\b[a-z]:\\[^\s,;]+/giu,
    "[LOCAL_PATH_REDACTED]",
  );
  return redacted;
};

const safeText = (value: string, maxLength = 4_000) =>
  redactSensitiveText(value).slice(0, maxLength);

const safeNullableText = (value: string | null | undefined, maxLength = 4_000) =>
  typeof value === "string" ? safeText(value, maxLength) : null;

const normalizeLogicalPath = (value: string | null | undefined) => {
  if (!value) return null;
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  return normalized.toLowerCase();
};

const safeFileName = (value: string | null | undefined) => {
  if (!value) return null;
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalizeLogicalPath(normalized)?.startsWith(".nodes/")) {
    return safeText(normalized, 300);
  }
  return safeText(normalized.split("/").at(-1) || "[file]", 300);
};

const artifactLogicalPath = (artifact: SessionArtifact) => {
  const fileName = normalizeLogicalPath(artifact.fileName);
  if (fileName?.startsWith(".nodes/")) return fileName;
  const title = normalizeLogicalPath(artifact.title);
  return title?.startsWith(".nodes/") ? title : null;
};

const safeArtifactTitle = (value: string) => {
  const normalized = value.trim().replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:\//iu.test(normalized)) {
    return safeFileName(normalized) ?? "[artifact]";
  }
  return safeText(value, 500);
};

const assertResourceId = (kind: "Project" | "Session", value: string) => {
  if (!SAFE_RESOURCE_ID.test(value)) {
    throw new NodesInvalidResourceError(`Invalid ${kind.toLowerCase()} id: ${value}`);
  }
};

const toProjectSummary = (project: ProjectSummary): NodesProjectSummary => ({
  accessRole: project.accessRole,
  createdAt: project.createdAt,
  id: project.id,
  sessionCount: project.sessionCount,
  title: safeNullableText(project.title, 500),
  updatedAt: project.updatedAt,
});

const toProject = (project: ProjectRecord, map: ProjectMap): NodesProject => ({
  ...toProjectSummary(project),
  globalContextPresent: project.globalContext.trim().length > 0,
  memoryCount: project.memoryIds.length,
  workloadCount: map.nodes.length,
});

const toSelectedOutput = (
  output: ProjectMapNode["selectedOutput"],
): NodesSelectedOutput | null => output
  ? {
      artifactIds: [...output.artifactIds],
      messageId: output.messageId,
      sessionId: output.sessionId,
      summary: safeText(output.summary),
      updatedAt: output.updatedAt,
    }
  : null;

const toWorkload = (node: ProjectMapNode): NodesWorkload => ({
  description: safeText(node.description),
  id: node.id,
  nodeType: node.nodeType ?? "workload",
  primarySessionId: node.primarySessionId,
  selectedOutput: toSelectedOutput(node.selectedOutput),
  sessionIds: [...node.sessionIds],
  status: node.status,
  title: safeText(node.title, 500),
});

const toArtifact = (artifact: SessionArtifact, sourceSessionId: string): NodesArtifact => ({
  artifactType: artifact.artifactType,
  byteSize: artifact.byteSize ?? null,
  createdAt: artifact.createdAt,
  fileName: safeFileName(artifact.fileName),
  id: artifact.id,
  mimeType: safeNullableText(artifact.mimeType, 200),
  semanticType: artifact.semanticType ?? null,
  sourceSessionId,
  title: safeArtifactTitle(artifact.title),
  updatedAt: artifact.updatedAt,
});

const parseCodexRuns = (snapshot: Record<string, unknown> | null): NodesCodexRun[] => {
  if (!Array.isArray(snapshot?.runs)) return [];
  return snapshot.runs.flatMap((entry) => {
    const run = asRecord(entry);
    if (!run) return [];
    return [{
      agentId: asString(run.agentId, 200),
      label: safeText(asString(run.label, 500) ?? "Codex Agent", 500),
      parentRunId: asString(run.parentRunId, 200),
      role: safeText(asString(run.role, 100) ?? "coder", 100),
      runId: asString(run.runId, 200),
      status: safeText(asString(run.status, 100) ?? "unknown", 100),
      threadId: asString(run.threadId, 200),
    }];
  });
};

const currentWorkload = (map: ProjectMap) => {
  const priorities = ["active", "blocked", "ready", "planned", "complete"] as const;
  for (const status of priorities) {
    const node = map.nodes.find((entry) => entry.status === status);
    if (node) {
      return {
        node,
        reason: `first ${status} workload in normalized project-map order`,
      };
    }
  }
  return { node: null, reason: "project map has no workloads" };
};

const lookupWorkload = (map: ProjectMap, idOrTitle: string) => {
  const normalized = idOrTitle.trim();
  const byId = map.nodes.find((node) => node.id === normalized);
  if (byId) return byId;
  const byTitle = map.nodes.filter((node) => node.title === normalized);
  if (byTitle.length > 1) {
    throw new NodesAmbiguousResourceError(
      `Ambiguous workload title: ${normalized}. Use a workload id.`,
    );
  }
  if (byTitle.length === 0) {
    throw new NodesResourceNotFoundError(`Workload not found: ${normalized}`);
  }
  return byTitle[0]!;
};

const toRunner = (status: CodexProjectRunnerStatus, projectId: string): NodesRunner => ({
  codexAuthenticated: status.authenticated,
  codexRunning: status.codexRunning,
  configured: status.configured,
  model: safeNullableText(status.model, 200),
  online: status.reachable,
  ready:
    status.reachable &&
    status.codexRunning &&
    status.authenticated &&
    status.workspaceConfigured,
  reason: safeText(status.nextStep.detail),
  reasonCode: status.nextStep.code,
  workspaceKey: projectId,
  workspaceMapped: status.workspaceConfigured,
});

const tychoRequiredFor = (node: ProjectMapNode | null, artifacts: SessionArtifact[]) => {
  if (artifacts.some((artifact) => artifactLogicalPath(artifact)?.startsWith(".nodes/tycho-"))) {
    return true;
  }
  if (!node) return false;
  return /\btycho\b/iu.test(`${node.title}\n${node.description}`);
};

const artifactAtPath = (artifacts: SessionArtifact[], logicalPath: string) =>
  artifacts.find((artifact) => artifactLogicalPath(artifact) === logicalPath) ?? null;

const resultArtifact = (artifacts: SessionArtifact[]) =>
  artifacts.find((artifact) => {
    const logicalPath = artifactLogicalPath(artifact);
    return logicalPath ? TYCHO_RESULT_PATHS.has(logicalPath) : false;
  }) ?? null;

const executionArtifact = (
  logicalPath: string,
  artifact: SessionArtifact | null,
): NodesExecutionArtifact => ({
  artifactId: artifact?.id ?? null,
  artifactType: artifact?.artifactType ?? null,
  path: logicalPath,
  present: artifact !== null,
  semanticType: artifact?.semanticType ?? null,
  source: "authoritative-primary-session",
});

const authoritativeArtifactsFor = (
  node: ProjectMapNode | null,
  artifacts: SessionArtifact[],
) => {
  if (tychoRequiredFor(node, artifacts)) {
    return [
      executionArtifact(
        TYCHO_PROTOCOL_PATH,
        artifactAtPath(artifacts, TYCHO_PROTOCOL_PATH),
      ),
      executionArtifact(
        TYCHO_EXPERIMENT_PATH,
        artifactAtPath(artifacts, TYCHO_EXPERIMENT_PATH),
      ),
    ];
  }
  return artifacts.map((artifact) => executionArtifact(
    safeFileName(artifact.fileName) ?? safeArtifactTitle(artifact.title),
    artifact,
  ));
};

const buildTycho = ({
  artifacts,
  node,
  runnerStatus,
}: {
  artifacts: SessionArtifact[];
  node: ProjectMapNode | null;
  runnerStatus: CodexProjectRunnerStatus;
}): NodesTycho => {
  const protocol = artifactAtPath(artifacts, TYCHO_PROTOCOL_PATH);
  const experiment = artifactAtPath(artifacts, TYCHO_EXPERIMENT_PATH);
  const result = resultArtifact(artifacts);
  const requiredForWorkload = tychoRequiredFor(node, artifacts);
  const knownBlockers: NodesExecutionBlocker[] = [];

  if (requiredForWorkload && !protocol) {
    knownBlockers.push({
      code: "authoritative_tycho_protocol_missing",
      message: "Authoritative Tycho protocol missing from the primary session.",
    });
  }
  if (requiredForWorkload && !experiment) {
    knownBlockers.push({
      code: "primary_session_execution_evidence_missing",
      message: "Primary-session execution evidence (.nodes/experiment.py) is missing.",
    });
  }
  if (requiredForWorkload && !runnerStatus.tycho.reported) {
    knownBlockers.push({
      code: "tycho_readiness_unavailable",
      message: "The configured runner did not report Tycho readiness.",
    });
  } else if (requiredForWorkload && runnerStatus.tycho.ready !== true) {
    knownBlockers.push({
      code: "tycho_not_ready",
      message: safeText(runnerStatus.tycho.reason ?? "Tycho is not ready on the configured runner."),
    });
  }

  return {
    authoritativeExperimentPresent: experiment !== null,
    authoritativeProtocolPresent: protocol !== null,
    authoritativeResultPresent: result !== null,
    currentDecision: safeNullableText(runnerStatus.tycho.decision),
    filesystemExperimentPresent: runnerStatus.tycho.filesystemExperimentPresent,
    filesystemProtocolPresent: runnerStatus.tycho.filesystemProtocolPresent,
    filesystemResultPresent: runnerStatus.tycho.filesystemResultPresent,
    image: safeNullableText(runnerStatus.tycho.image, 300),
    knownBlockers,
    ready: runnerStatus.tycho.ready,
    reportedByRunner: runnerStatus.tycho.reported,
    requiredForWorkload,
    runtime: safeNullableText(runnerStatus.tycho.runtime, 100),
  };
};

const buildExecution = ({
  accessRole,
  node,
  primarySession,
  runner,
  tycho,
}: {
  accessRole: ProjectRecord["accessRole"];
  node: ProjectMapNode | null;
  primarySession: SessionDocument | null;
  runner: NodesRunner;
  tycho: NodesTycho;
}): NodesExecution => {
  const blockers: NodesExecutionBlocker[] = [];
  if (!node) {
    blockers.push({ code: "workload_missing", message: "No current workload could be derived." });
  }
  if (accessRole !== "owner") {
    blockers.push({
      code: "project_owner_required",
      message: "Only the project owner can start a managed project run.",
    });
  }
  if (node && !node.primarySessionId) {
    blockers.push({
      code: "primary_session_missing",
      message: "The current workload has no primary session.",
    });
  } else if (node?.primarySessionId && !primarySession) {
    blockers.push({
      code: "primary_session_not_found",
      message: `Primary session not found: ${node.primarySessionId}`,
    });
  }
  if (!runner.configured) {
    blockers.push({ code: "runner_not_configured", message: runner.reason });
  } else if (!runner.online) {
    blockers.push({ code: "runner_unavailable", message: runner.reason });
  } else {
    if (!runner.codexRunning) {
      blockers.push({ code: "codex_not_running", message: runner.reason });
    }
    if (!runner.codexAuthenticated) {
      blockers.push({ code: "codex_not_authenticated", message: runner.reason });
    }
    if (!runner.workspaceMapped) {
      blockers.push({ code: "workspace_not_mapped", message: runner.reason });
    }
  }
  blockers.push(...tycho.knownBlockers);
  const uniqueBlockers = [...new Map(blockers.map((blocker) => [blocker.code, blocker])).values()];
  return { blockers: uniqueBlockers, runnable: uniqueBlockers.length === 0 };
};

export class NodesInspectionService {
  private readonly actor: ProjectActor;
  private readonly agentWorkRepository: AgentWorkRepository;
  private readonly projectRepository: ProjectRepository;
  private readonly runnerStatusLoader: NodesRunnerStatusLoader;
  private readonly sessionRepository: SessionRepository;

  constructor(options: NodesInspectionServiceOptions) {
    this.actor = { ...options.actor, claimLegacyOwnership: false };
    this.agentWorkRepository = options.agentWorkRepository ?? getAgentWorkRepository();
    this.projectRepository = options.projectRepository ?? getProjectRepository();
    this.runnerStatusLoader = options.runnerStatusLoader ?? getCodexProjectRunnerStatus;
    this.sessionRepository = options.sessionRepository ?? getSessionRepository();
  }

  async listProjects() {
    return (await this.projectRepository.listProjectsForActor(this.actor)).map(toProjectSummary);
  }

  async inspectProject(projectId: string) {
    const loaded = await this.loadProject(projectId);
    return toProject(loaded.record, loaded.map);
  }

  async inspectProjectMap(projectId: string): Promise<NodesProjectMap> {
    const loaded = await this.loadProject(projectId);
    return {
      edges: loaded.map.edges.map((edge) => ({
        id: edge.id,
        label: safeNullableText(edge.label, 500),
        sourceWorkloadId: edge.sourceNodeId,
        targetWorkloadId: edge.targetNodeId,
      })),
      project: toProject(loaded.record, loaded.map),
      schemaVersion: NODES_CLI_SCHEMA_VERSION,
      workloads: loaded.map.nodes.map(toWorkload),
    };
  }

  async listWorkloads(projectId: string) {
    const loaded = await this.loadProject(projectId);
    return {
      project: toProject(loaded.record, loaded.map),
      schemaVersion: NODES_CLI_SCHEMA_VERSION,
      workloads: loaded.map.nodes.map(toWorkload),
    };
  }

  async inspectWorkload(
    projectId: string,
    workloadIdOrTitle: string,
  ): Promise<NodesWorkloadInspection> {
    const loaded = await this.loadProject(projectId);
    const node = lookupWorkload(loaded.map, workloadIdOrTitle);
    return this.buildWorkloadInspection(loaded, node);
  }

  async diagnoseProject(projectId: string): Promise<NodesProjectDiagnosis> {
    const loaded = await this.loadProject(projectId);
    const selection = currentWorkload(loaded.map);
    if (!selection.node) {
      const runnerStatus = await this.runnerStatusLoader({
        ownerId: loaded.record.ownerId,
        workspaceId: projectId,
      });
      const runner = toRunner(runnerStatus, projectId);
      const tycho = buildTycho({ artifacts: [], node: null, runnerStatus });
      return {
        artifacts: [],
        authoritativeArtifacts: [],
        execution: buildExecution({
          accessRole: loaded.record.accessRole,
          node: null,
          primarySession: null,
          runner,
          tycho,
        }),
        primarySession: null,
        project: toProject(loaded.record, loaded.map),
        runner,
        schemaVersion: NODES_CLI_SCHEMA_VERSION,
        sessions: [],
        tycho,
        upstream: [],
        workload: null,
        workloadSelection: {
          reason: selection.reason,
          source: "derived-project-map-state",
        },
      };
    }

    const inspection = await this.buildWorkloadInspection(loaded, selection.node);
    const primaryArtifacts = selection.node.primarySessionId
      ? loaded.sessions.get(selection.node.primarySessionId)?.artifacts ?? []
      : [];
    return {
      ...inspection,
      authoritativeArtifacts: authoritativeArtifactsFor(selection.node, primaryArtifacts),
      workloadSelection: {
        reason: selection.reason,
        source: "derived-project-map-state",
      },
    };
  }

  async inspectSession(sessionId: string): Promise<NodesSession> {
    assertResourceId("Session", sessionId);
    const accessible = await this.loadAccessibleProjectRecords();
    const associations = this.sessionAssociations(sessionId, accessible);
    const ownerId = accessible.find(({ record }) =>
      record.sessionIds.includes(sessionId))?.record.ownerId ?? this.actor.userId;
    const session = await this.getSessionOrNull(sessionId, ownerId);
    if (!session) throw new NodesResourceNotFoundError(`Session not found: ${sessionId}`);
    return this.toSession(
      session,
      associations,
      this.sessionSelectedOutputs(sessionId, accessible),
      ownerId,
    );
  }

  async inspectSessionArtifacts(sessionId: string) {
    const session = await this.inspectSession(sessionId);
    return {
      artifacts: session.artifacts,
      schemaVersion: NODES_CLI_SCHEMA_VERSION,
      session: {
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
      },
    };
  }

  async inspectRunner(projectId: string) {
    const loaded = await this.loadProject(projectId);
    return toRunner(
      await this.runnerStatusLoader({
        ownerId: loaded.record.ownerId,
        workspaceId: projectId,
      }),
      projectId,
    );
  }

  async inspectTycho(projectId: string) {
    const diagnosis = await this.diagnoseProject(projectId);
    return {
      execution: diagnosis.execution,
      project: diagnosis.project,
      schemaVersion: NODES_CLI_SCHEMA_VERSION,
      tycho: diagnosis.tycho,
      workload: diagnosis.workload,
    };
  }

  private async buildWorkloadInspection(
    loaded: LoadedProject,
    node: ProjectMapNode,
  ): Promise<NodesWorkloadInspection> {
    const associations = node.sessionIds.map<NodesSessionAssociation>((sessionId) => ({
      isPrimary: node.primarySessionId === sessionId,
      projectId: loaded.record.id,
      projectTitle: safeNullableText(loaded.record.title, 500),
      workloadId: node.id,
      workloadTitle: safeText(node.title, 500),
    }));
    const selectedOutputReferences = node.selectedOutput
      ? [{
          output: toSelectedOutput(node.selectedOutput)!,
          projectId: loaded.record.id,
          workloadId: node.id,
          workloadTitle: safeText(node.title, 500),
        }]
      : [];
    const sessions = await Promise.all(
      node.sessionIds.flatMap((sessionId) => {
        const session = loaded.sessions.get(sessionId);
        if (!session) return [];
        return [this.toSession(
          session,
          associations.filter((association) => association.workloadId === node.id),
          selectedOutputReferences.filter((reference) =>
            reference.output.sessionId === session.id),
          loaded.record.ownerId,
        )];
      }),
    );
    const primaryDocument = node.primarySessionId
      ? loaded.sessions.get(node.primarySessionId) ?? null
      : null;
    const primarySession = node.primarySessionId
      ? sessions.find((session) => session.id === node.primarySessionId) ?? null
      : null;
    const primaryArtifacts = primaryDocument?.artifacts ?? [];
    const runnerStatus = await this.runnerStatusLoader({
      ownerId: loaded.record.ownerId,
      workspaceId: loaded.record.id,
    });
    const runner = toRunner(runnerStatus, loaded.record.id);
    const tycho = buildTycho({ artifacts: primaryArtifacts, node, runnerStatus });
    return {
      artifacts: primaryArtifacts.map((artifact) => toArtifact(artifact, primaryDocument!.id)),
      execution: buildExecution({
        accessRole: loaded.record.accessRole,
        node,
        primarySession: primaryDocument,
        runner,
        tycho,
      }),
      primarySession,
      project: toProject(loaded.record, loaded.map),
      runner,
      schemaVersion: NODES_CLI_SCHEMA_VERSION,
      sessions,
      tycho,
      upstream: this.upstreamFor(loaded, node),
      workload: toWorkload(node),
    };
  }

  private upstreamFor(loaded: LoadedProject, node: ProjectMapNode): NodesUpstream[] {
    return getProjectMapUpstreamNodes(loaded.map, node.id).map((upstream) => {
      const output = upstream.selectedOutput;
      const outputSession = output ? loaded.sessions.get(output.sessionId) ?? null : null;
      const selectedIds = new Set(output?.artifactIds ?? []);
      return {
        artifacts: (outputSession?.artifacts ?? [])
          .filter((artifact) => selectedIds.has(artifact.id))
          .map((artifact) => toArtifact(artifact, outputSession!.id)),
        selectedOutput: toSelectedOutput(output),
        workload: toWorkload(upstream),
      };
    });
  }

  private async loadProject(projectId: string): Promise<LoadedProject> {
    assertResourceId("Project", projectId);
    let record: ProjectRecord;
    try {
      record = await this.projectRepository.getProjectRecordForActor(projectId, this.actor);
    } catch (error) {
      if (error instanceof Error && error.message === "Project not found") {
        throw new NodesResourceNotFoundError(`Project not found: ${projectId}`);
      }
      throw error;
    }
    const map = normalizeProjectMap(record.map);
    const sessions = new Map<string, SessionDocument>();
    await Promise.all(record.sessionIds.map(async (sessionId) => {
      const session = await this.getSessionOrNull(sessionId, record.ownerId);
      if (session) sessions.set(sessionId, session);
    }));
    return { map, record, sessions };
  }

  private async loadAccessibleProjectRecords() {
    const summaries = await this.projectRepository.listProjectsForActor(this.actor);
    const loaded = await Promise.all(summaries.map(async (summary) => {
      try {
        const record = await this.projectRepository.getProjectRecordForActor(summary.id, this.actor);
        return { map: normalizeProjectMap(record.map), record };
      } catch (error) {
        if (error instanceof Error && error.message === "Project not found") return null;
        throw error;
      }
    }));
    return loaded.filter((entry): entry is { map: ProjectMap; record: ProjectRecord } =>
      entry !== null);
  }

  private sessionAssociations(
    sessionId: string,
    projects: Array<{ map: ProjectMap; record: ProjectRecord }>,
  ) {
    return projects.flatMap(({ map, record }) =>
      map.nodes.flatMap((node) => node.sessionIds.includes(sessionId)
        ? [{
            isPrimary: node.primarySessionId === sessionId,
            projectId: record.id,
            projectTitle: safeNullableText(record.title, 500),
            workloadId: node.id,
            workloadTitle: safeText(node.title, 500),
          } satisfies NodesSessionAssociation]
        : []));
  }

  private sessionSelectedOutputs(
    sessionId: string,
    projects: Array<{ map: ProjectMap; record: ProjectRecord }>,
  ): SessionOutputReference[] {
    return projects.flatMap(({ map, record }) =>
      map.nodes.flatMap((node) => node.selectedOutput?.sessionId === sessionId
        ? [{
            output: toSelectedOutput(node.selectedOutput)!,
            projectId: record.id,
            workloadId: node.id,
            workloadTitle: safeText(node.title, 500),
          }]
        : []));
  }

  private async toSession(
    session: SessionDocument,
    associations: NodesSessionAssociation[],
    selectedOutputs: SessionOutputReference[],
    ownerId: string,
  ): Promise<NodesSession> {
    const events = await this.agentWorkRepository.listAgentEvents(ownerId, {
      eventType: "codex.canvas.snapshot",
      limit: 1,
      sessionId: session.id,
    });
    const snapshot = asRecord(asRecord(events[0]?.payload)?.snapshot);
    return {
      archived: session.archived,
      artifactCount: session.artifacts.length,
      artifacts: session.artifacts.map((artifact) => toArtifact(artifact, session.id)),
      associations,
      codex: {
        runs: parseCodexRuns(snapshot),
        snapshotUpdatedAt: asString(snapshot?.updatedAt, 100),
      },
      createdAt: session.createdAt,
      id: session.id,
      messageCount: session.messageCount,
      selectedOutputs,
      title: safeNullableText(session.title, 500),
      updatedAt: session.updatedAt,
      version: session.version,
    };
  }

  private async getSessionOrNull(sessionId: string, ownerId: string) {
    try {
      return await this.sessionRepository.getSession(sessionId, ownerId, {
        claimLegacyOwnership: false,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Session not found") return null;
      if (asRecord(error)?.code === "ENOENT") return null;
      throw error;
    }
  }
}
