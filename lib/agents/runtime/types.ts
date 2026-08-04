/**
 * Provider-neutral contracts for Canvas agent nodes.
 *
 * Runtime-specific payloads stay in their adapter. These types are deliberately
 * small enough to be shared by the Canvas, API routes, runner services, and
 * persistence without making any one of them depend on a provider SDK.
 */

export const AGENT_RUNTIME_SCHEMA_VERSION = 1 as const;

export type AgentRuntimeId = "codex" | "nooa";

export type AgentRuntimeCapability =
  | "approvals"
  | "child_agents"
  | "event_stream"
  | "file_changes"
  | "sandbox_policy"
  | "trace_export";

export type AgentRuntimeDeliveryStatus = "enabled" | "planned";

export type AgentRuntimeDefinition = {
  id: AgentRuntimeId;
  label: string;
  deliveryStatus: AgentRuntimeDeliveryStatus;
  capabilities: readonly AgentRuntimeCapability[];
  supportedRoles: readonly string[];
  requiresOpenShellPolicy: boolean;
};

export type AgentRuntimeCatalog = Record<AgentRuntimeId, AgentRuntimeDefinition>;

/**
 * A policy identifier is resolved by the server-side runtime gateway. Browser
 * clients never send file paths, raw policy documents, or sandbox credentials.
 */
export type OpenShellSandboxBinding = {
  provider: "openshell";
  policyId: string;
  profileId?: string | null;
};

export type AgentRuntimeNode = {
  id: string;
  runtime: AgentRuntimeId;
  sessionId: string;
  prompt: string;
  label?: string | null;
  role?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
  parentRunId?: string | null;
  sandbox?: OpenShellSandboxBinding | null;
  metadata?: Record<string, unknown>;
};

export type AgentRuntimeCompileIssueCode =
  | "missing_node_id"
  | "missing_session_id"
  | "missing_prompt"
  | "unsupported_role"
  | "missing_openshell_policy"
  | "invalid_openshell_policy";

export type AgentRuntimeCompileIssue = {
  code: AgentRuntimeCompileIssueCode;
  path: string;
  message: string;
};

export type CompiledAgentRun = {
  schemaVersion: typeof AGENT_RUNTIME_SCHEMA_VERSION;
  nodeId: string;
  runtime: AgentRuntimeId;
  sessionId: string;
  prompt: string;
  label: string;
  role: string;
  projectId: string | null;
  workspaceId: string | null;
  parentRunId: string | null;
  sandbox: OpenShellSandboxBinding | null;
  metadata: Record<string, unknown>;
};

export type CompileAgentNodeResult =
  | { ok: true; run: CompiledAgentRun }
  | { ok: false; issues: AgentRuntimeCompileIssue[] };

/**
 * Canonical lifecycle vocabulary emitted by runtime adapters. Provider-specific
 * details remain inside `payload` and can evolve without changing Canvas state.
 */
export type AgentRuntimeEventType =
  | "run.queued"
  | "agent.started"
  | "agent.message.delta"
  | "agent.message.completed"
  | "agent.child.spawned"
  | "tool.started"
  | "tool.completed"
  | "shell.started"
  | "shell.completed"
  | "file.changed"
  | "artifact.created"
  | "approval.requested"
  | "approval.resolved"
  | "sandbox.policy.decision"
  | "trace.recorded"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "runtime.unknown";

export type AgentRuntimeEventSource = "runtime" | "sandbox" | "compiler";

export type AgentRuntimeEventDraft = {
  id?: string;
  runId: string;
  nodeId: string;
  runtime: AgentRuntimeId;
  type: AgentRuntimeEventType;
  source: AgentRuntimeEventSource;
  createdAt?: string;
  parentRunId?: string | null;
  payload?: Record<string, unknown>;
};

export type AgentRuntimeEvent = Required<
  Pick<AgentRuntimeEventDraft, "id" | "runId" | "nodeId" | "runtime" | "type" | "source">
> & {
  sequence: number;
  createdAt: string;
  parentRunId: string | null;
  payload: Record<string, unknown>;
};

export type AgentRuntimeRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentRuntimeStartRequest = {
  ownerId: string;
  run: CompiledAgentRun;
};

export type AgentRuntimeStartResponse = {
  runId: string;
  runtime: AgentRuntimeId;
  nodeId: string;
  status: AgentRuntimeRunStatus;
  providerRunId?: string | null;
  threadId?: string | null;
};

export type AgentRuntimeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type AgentRuntimeAdapter = {
  definition: AgentRuntimeDefinition;
  start: (input: AgentRuntimeStartRequest) => Promise<AgentRuntimeStartResponse>;
  cancel?: (input: { ownerId: string; runId: string }) => Promise<void>;
  resolveApproval?: (input: {
    ownerId: string;
    runId: string;
    approvalId: string;
    decision: AgentRuntimeApprovalDecision;
  }) => Promise<void>;
};
