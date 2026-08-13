export type CodexAgentRole =
  | "coder"
  | "reviewer"
  | "researcher"
  | "tester"
  | "custom";

export type CodexRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type CodexApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type CodexRunnerApprovalMode = "interactive" | "tycho-isolated" | "hypothesis-only";

export type CodexWorkspaceFile = {
  path: string;
  content: string;
  artifactId?: string | null;
  mimeType?: string | null;
};

export type StartCodexRunInput = {
  sessionId: string;
  prompt: string;
  projectId?: string | null;
  workspaceId?: string | null;
  cwd?: string | null;
  parentRunId?: string | null;
  role?: CodexAgentRole;
  label?: string | null;
  metadata?: Record<string, unknown>;
};

export type CodexRunnerStartRequest = StartCodexRunInput & {
  ownerId: string;
  approvalMode?: CodexRunnerApprovalMode;
  workspaceFiles?: CodexWorkspaceFile[];
};

export type CodexRunnerStartResponse = {
  runId: string;
  threadId?: string | null;
  status: CodexRunStatus;
  agentId?: string | null;
  parentRunId?: string | null;
};

export type CodexCanvasEventType =
  | "agent.started"
  | "agent.message.delta"
  | "agent.message.completed"
  | "agent.child.spawned"
  | "tool.started"
  | "tool.completed"
  | "shell.started"
  | "shell.completed"
  | "file.changed"
  | "approval.requested"
  | "approval.resolved"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "unknown";

export type CodexCanvasEvent = {
  id: string;
  runId: string;
  threadId?: string | null;
  parentRunId?: string | null;
  agentId?: string | null;
  type: CodexCanvasEventType;
  createdAt: string;
  payload: Record<string, unknown>;
};

export type CodexPersistedRun = {
  localId: string;
  runId: string | null;
  threadId: string | null;
  agentId: string | null;
  parentLocalId: string | null;
  parentRunId: string | null;
  role: CodexAgentRole;
  label: string;
  prompt: string;
  output: string;
  status: CodexRunStatus;
  events: CodexCanvasEvent[];
  pendingApprovalId: string | null;
  error: string | null;
  position: { x: number; y: number };
};

export type CodexCanvasSnapshot = {
  version: 1;
  sessionId: string;
  projectId: string | null;
  runs: CodexPersistedRun[];
  updatedAt: string;
};

export type CodexRunnerEventEnvelope = {
  id?: string;
  runId: string;
  threadId?: string | null;
  parentRunId?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  createdAt?: string;
  notification: CodexAppServerNotification;
};

export type CodexAppServerNotification = {
  method: string;
  params?: unknown;
};