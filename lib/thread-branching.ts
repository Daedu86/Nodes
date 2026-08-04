import type { Node } from "@/components/assistant-ui/thread-graph/graph-types";
import { ROOT_NODE_ID } from "@/components/assistant-ui/thread-graph/graph-types";

export type BranchOperation =
  | "new-root-prompt"
  | "create-sibling-prompt"
  | "create-follow-up-prompt";

export type BranchOperationDetail = {
  operation: BranchOperation;
  title: string;
  description: string;
  placeholder: string;
  submitLabel: string;
};

export type BranchAnchor = Pick<Node, "id" | "parentId" | "role" | "isBridge">;

export type BranchSpec = {
  operation: BranchOperation;
  anchorId: string;
  anchorRole: string;
  parentId: string | null;
  sourceId: string | null;
  targetRole: "user";
  startRun: boolean;
  placeholder: string;
  title: string;
};

export const BRANCH_OPERATION_DETAILS: Record<BranchOperation, BranchOperationDetail> = {
  "new-root-prompt": {
    operation: "new-root-prompt",
    title: "Create root branch",
    description: "Create a new top-level branch from the conversation root.",
    placeholder: "Start another root branch...",
    submitLabel: "Create branch",
  },
  "create-sibling-prompt": {
    operation: "create-sibling-prompt",
    title: "Create sibling branch",
    description: "Create a sibling branch from the same parent while preserving the original prompt.",
    placeholder: "Revise this prompt for a sibling branch...",
    submitLabel: "Create branch",
  },
  "create-follow-up-prompt": {
    operation: "create-follow-up-prompt",
    title: "Add follow-up question",
    description: "Ask a new follow-up question beneath this assistant reply.",
    placeholder: "Write a follow-up question...",
    submitLabel: "Add follow-up",
  },
};

const normalizeRuntimeParentId = (parentId: string | null) =>
  parentId === ROOT_NODE_ID ? null : parentId;

const isRootAnchor = (anchor: BranchAnchor) => anchor.id === ROOT_NODE_ID;

export const getAllowedBranchOperations = (anchor: BranchAnchor): BranchOperation[] => {
  if (anchor.isBridge) {
    return [];
  }

  if (isRootAnchor(anchor)) {
    return ["new-root-prompt"];
  }

  if (anchor.role === "user") {
    return ["create-sibling-prompt"];
  }

  if (anchor.role === "assistant") {
    return ["create-follow-up-prompt"];
  }

  return [];
};

export const getBranchOperationDetail = (operation: BranchOperation) =>
  BRANCH_OPERATION_DETAILS[operation];

export const buildBranchSpec = (
  anchor: BranchAnchor,
  operation: BranchOperation,
): BranchSpec | null => {
  if (!getAllowedBranchOperations(anchor).includes(operation)) {
    return null;
  }

  const detail = getBranchOperationDetail(operation);

  switch (operation) {
    case "new-root-prompt":
      return {
        operation,
        anchorId: anchor.id,
        anchorRole: anchor.role,
        parentId: null,
        sourceId: null,
        targetRole: "user",
        startRun: true,
        placeholder: detail.placeholder,
        title: detail.title,
      };

    case "create-sibling-prompt":
      return {
        operation,
        anchorId: anchor.id,
        anchorRole: anchor.role,
        parentId: normalizeRuntimeParentId(anchor.parentId),
        sourceId: anchor.id,
        targetRole: "user",
        startRun: true,
        placeholder: detail.placeholder,
        title: detail.title,
      };

    case "create-follow-up-prompt":
      return {
        operation,
        anchorId: anchor.id,
        anchorRole: anchor.role,
        parentId: anchor.id,
        sourceId: null,
        targetRole: "user",
        startRun: true,
        placeholder: detail.placeholder,
        title: detail.title,
      };

    default:
      return null;
  }
};
