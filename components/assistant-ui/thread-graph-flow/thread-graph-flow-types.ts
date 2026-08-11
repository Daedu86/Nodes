"use client";

import type { Edge, Node } from "@xyflow/react";
import type {
  CodexAgentRole,
  CodexApprovalDecision,
  CodexCanvasEventType,
  CodexRunStatus,
} from "@/lib/agents/codex/types";
import type { ProjectMemoryType } from "@/lib/memory-documents";
import type {
  SessionArtifactSemanticType,
  SessionArtifactSyncMode,
  SessionCanvasPromptStatus,
  SessionArtifactType,
} from "@/lib/session-artifacts";
import type { BranchOperation, BranchOperationDetail } from "@/lib/thread-branching";

export type ThreadGraphFlowNodeData = {
  accent?: string;
  artifactType?: SessionArtifactType | null;
  branchId?: string | number | null;
  byteSize?: number | null;
  depth?: number;
  draftBusy?: boolean;
  draftContextCount?: number;
  draftOutputCount?: number;
  draftDetail?: BranchOperationDetail | null;
  draftDisabled?: boolean;
  draftError?: string | null;
  draftOperation?: BranchOperation | null;
  draftRunInterruptionNote?: string | null;
  draftText?: string;
  draftContextScope?: "parent" | "branch" | "tree" | null;
  contextScope?: "parent" | "branch" | "tree" | null;
  contextMessageCount?: number;
  onDraftContextScopeChange?: (scope: "parent" | "branch" | "tree") => void;
  onContextScopeChange?: (scope: "parent" | "branch" | "tree") => void;
  emphasis?: "normal" | "selected" | "lineage" | "muted";
  editedFromId?: string | null;
  fileName?: string | null;
  filterMatched?: boolean;
  isBridge?: boolean;
  isCut?: boolean;
  isRoot?: boolean;
  kind?:
    | "root"
    | "bridge"
    | "message"
    | "artifact"
    | "prompt-draft"
    | "canvas-prompt"
    | "canvas-response"
    | "agent-run"
    | "agent-activity";
  language?: string | null;
  linkedArtifactCount?: number;
  mapNodeId?: string | null;
  memoryId?: string | null;
  memoryType?: ProjectMemoryType | null;
  model?: string | null;
  modelLabel?: string;
  mimeType?: string | null;
  semanticType?: SessionArtifactSemanticType | null;
  position?: { x: number; y: number } | null;
  promptResult?: string | null;
  promptStatus?: SessionCanvasPromptStatus | null;
  preview: string;
  provider?: string | null;
  providerLabel?: string;
  revisionCount?: number;
  role: string;
  idx?: number;
  messageId?: string | null;
  sessionId?: string | null;
  sessionIds?: string[];
  sessionTitle?: string | null;
  sourceDataUrl?: string | null;
  statusLabel?: string | null;
  syncMode?: SessionArtifactSyncMode;
  title?: string | null;

  agentRunId?: string | null;
  agentThreadId?: string | null;
  agentParentRunId?: string | null;
  agentStatus?: CodexRunStatus | null;
  agentRole?: CodexAgentRole | null;
  agentPrompt?: string;
  agentOutput?: string;
  agentEventCount?: number;
  agentError?: string | null;
  agentPendingApprovalId?: string | null;
  agentActivityType?: CodexCanvasEventType | null;
  agentActivityCreatedAt?: string | null;
  onAgentPromptChange?: (value: string) => void;
  onAgentRoleChange?: (role: CodexAgentRole) => void;
  onAgentStart?: () => void;
  onAgentCancel?: () => void;
  onAgentRemove?: () => void;
  onAgentSpawnChild?: () => void;
  onAgentApproval?: (decision: CodexApprovalDecision) => void;

  onDraftCancel?: () => void;
  onDraftCancelRun?: () => void;
  onDraftSubmit?: () => void;
  onDraftTextChange?: (value: string) => void;
  onBranchOperation?: (operation: BranchOperation) => void;
  onCopyGraphJson?: () => void;
  onToggleLinkEdit?: () => void;
  linkEditMode?: boolean;
};

export type ThreadGraphFlowEdgeData = {
  accent?: string;
  editable?: boolean;
  emphasis?: "normal" | "selected" | "lineage" | "muted";
  isBridge?: boolean;
  isEdited?: boolean;
  label?: string;
  linkEditMode?: boolean;
  onCut?: () => void;
  tone?:
    | "default"
    | "bridge"
    | "context"
    | "edited"
    | "draft"
    | "output"
    | "pending-output";
};

export type ThreadGraphFlowNode = Node<ThreadGraphFlowNodeData>;
export type ThreadGraphFlowEdge = Edge<ThreadGraphFlowEdgeData>;
