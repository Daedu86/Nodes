import {
  ROOT_NODE_ID,
  ROOT_NODE_LABEL,
  type Node as ThreadGraphNodeModel,
} from "@/components/assistant-ui/thread-graph/graph-types";

export type ManualConversationRoot = {
  position: { x: number; y: number } | null;
};

export const getManualConversationRootStorageKey = (sessionId: string) =>
  `nodes.canvas-manual-conversation-root.v1:${sessionId}`;

export const parseManualConversationRoot = (
  raw: string | null,
): ManualConversationRoot | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { position?: { x?: unknown; y?: unknown } | null };
    if (parsed.position === null) return { position: null };
    if (
      parsed.position &&
      typeof parsed.position.x === "number" &&
      Number.isFinite(parsed.position.x) &&
      typeof parsed.position.y === "number" &&
      Number.isFinite(parsed.position.y)
    ) {
      return { position: { x: parsed.position.x, y: parsed.position.y } };
    }
  } catch {
    // Ignore stale or invalid browser state.
  }
  return null;
};

export const resolveCanvasConversationNodes = ({
  contextScopes,
  manualRoot,
  nodes,
}: {
  contextScopes: Record<string, "parent" | "branch" | "tree">;
  manualRoot: ManualConversationRoot | null;
  nodes: ThreadGraphNodeModel[];
}): ThreadGraphNodeModel[] => {
  if (nodes.length > 0) {
    return nodes.map((node) => ({
      ...node,
      contextScope: contextScopes[node.id] ?? node.contextScope ?? null,
    }));
  }
  if (!manualRoot) return [];

  return [
    {
      id: ROOT_NODE_ID,
      parentId: null,
      role: "ROOT",
      text: ROOT_NODE_LABEL,
      depth: 0,
      idx: -1,
      branchId: null,
      isBridge: false,
      model: null,
      provider: null,
      contextScope: null,
      x: manualRoot.position?.x,
      y: manualRoot.position?.y,
    },
  ];
};
