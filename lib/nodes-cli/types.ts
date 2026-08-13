import type { ProjectAccessRole } from "@/lib/project-documents";
import type {
  ProjectMapNodeStatus,
  ProjectMapNodeType,
} from "@/lib/project-map";
import type {
  SessionArtifactSemanticType,
  SessionArtifactType,
} from "@/lib/session-artifacts";

export const NODES_CLI_SCHEMA_VERSION = 1 as const;

export type NodesProjectSummary = {
  accessRole: ProjectAccessRole;
  createdAt: string;
  id: string;
  sessionCount: number;
  title: string | null;
  updatedAt: string;
};

export type NodesProject = NodesProjectSummary & {
  globalContextPresent: boolean;
  memoryCount: number;
  workloadCount: number;
};

export type NodesArtifact = {
  artifactType: SessionArtifactType;
  byteSize: number | null;
  createdAt: string;
  fileName: string | null;
  id: string;
  mimeType: string | null;
  semanticType: SessionArtifactSemanticType | null;
  sourceSessionId: string;
  title: string;
  updatedAt: string;
};

export type NodesSelectedOutput = {
  artifactIds: string[];
  messageId: string | null;
  sessionId: string;
  summary: string;
  updatedAt: string | null;
};

export type NodesWorkload = {
  description: string;
  id: string;
  nodeType: ProjectMapNodeType;
  primarySessionId: string | null;
  selectedOutput: NodesSelectedOutput | null;
  sessionIds: string[];
  status: ProjectMapNodeStatus;
  title: string;
};

export type NodesProjectMap = {
  edges: Array<{
    id: string;
    label: string | null;
    sourceWorkloadId: string;
    targetWorkloadId: string;
  }>;
  project: NodesProject;
  schemaVersion: typeof NODES_CLI_SCHEMA_VERSION;
  workloads: NodesWorkload[];
};

export type NodesSessionAssociation = {
  isPrimary: boolean;
  projectId: string;
  projectTitle: string | null;
  workloadId: string;
  workloadTitle: string;
};

export type NodesCodexRun = {
  agentId: string | null;
  label: string;
  parentRunId: string | null;
  role: string;
  runId: string | null;
  status: string;
  threadId: string | null;
};

export type NodesSession = {
  archived: boolean;
  artifactCount: number;
  artifacts: NodesArtifact[];
  associations: NodesSessionAssociation[];
  codex: {
    runs: NodesCodexRun[];
    snapshotUpdatedAt: string | null;
  };
  createdAt: string;
  id: string;
  messageCount: number;
  selectedOutputs: Array<{
    projectId: string;
    workloadId: string;
    workloadTitle: string;
    output: NodesSelectedOutput;
  }>;
  title: string | null;
  updatedAt: string;
  version: number;
};

export type NodesUpstream = {
  artifacts: NodesArtifact[];
  selectedOutput: NodesSelectedOutput | null;
  workload: NodesWorkload;
};

export type NodesRunner = {
  codexAuthenticated: boolean;
  codexRunning: boolean;
  configured: boolean;
  model: string | null;
  online: boolean;
  ready: boolean;
  reason: string;
  reasonCode: string;
  workspaceKey: string;
  workspaceMapped: boolean;
};

export type NodesTycho = {
  authoritativeExperimentPresent: boolean;
  authoritativeProtocolPresent: boolean;
  authoritativeResultPresent: boolean;
  currentDecision: string | null;
  filesystemExperimentPresent: boolean | null;
  filesystemProtocolPresent: boolean | null;
  filesystemResultPresent: boolean | null;
  image: string | null;
  knownBlockers: NodesExecutionBlocker[];
  ready: boolean | null;
  reportedByRunner: boolean;
  requiredForWorkload: boolean;
  runtime: string | null;
};

export type NodesExecutionArtifact = {
  artifactId: string | null;
  artifactType: SessionArtifactType | null;
  path: string;
  present: boolean;
  semanticType: SessionArtifactSemanticType | null;
  source: "authoritative-primary-session";
};

export type NodesExecutionBlocker = {
  code: string;
  message: string;
};

export type NodesExecution = {
  blockers: NodesExecutionBlocker[];
  runnable: boolean;
};

export type NodesWorkloadInspection = {
  artifacts: NodesArtifact[];
  execution: NodesExecution;
  primarySession: NodesSession | null;
  project: NodesProject;
  runner: NodesRunner;
  schemaVersion: typeof NODES_CLI_SCHEMA_VERSION;
  sessions: NodesSession[];
  tycho: NodesTycho;
  upstream: NodesUpstream[];
  workload: NodesWorkload;
};

export type NodesProjectDiagnosis = Omit<
  NodesWorkloadInspection,
  "workload"
> & {
  authoritativeArtifacts: NodesExecutionArtifact[];
  workload: NodesWorkload | null;
  workloadSelection: {
    reason: string;
    source: "derived-project-map-state";
  };
};
