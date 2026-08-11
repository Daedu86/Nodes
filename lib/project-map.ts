export const PROJECT_MAP_VERSION = 1 as const;

export const PROJECT_MAP_NODE_STATUSES = [
  "planned",
  "ready",
  "active",
  "complete",
  "blocked",
] as const;

export type ProjectMapNodeStatus = (typeof PROJECT_MAP_NODE_STATUSES)[number];

export type ProjectMapNodeOutput = {
  artifactIds: string[];
  messageId: string | null;
  sessionId: string;
  summary: string;
  updatedAt: string | null;
};

export type ProjectMapNode = {
  description: string;
  id: string;
  primarySessionId: string | null;
  selectedOutput: ProjectMapNodeOutput | null;
  sessionIds: string[];
  status: ProjectMapNodeStatus;
  title: string;
};

export type ProjectMapEdge = {
  id: string;
  label: string | null;
  sourceNodeId: string;
  targetNodeId: string;
};

export type ProjectMap = {
  edges: ProjectMapEdge[];
  nodes: ProjectMapNode[];
  version: typeof PROJECT_MAP_VERSION;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const normalizeString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const normalizeStringList = (value: unknown) =>
  Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))]
    : [];

const normalizeNodeStatus = (value: unknown): ProjectMapNodeStatus =>
  typeof value === "string" && PROJECT_MAP_NODE_STATUSES.includes(value as ProjectMapNodeStatus)
    ? (value as ProjectMapNodeStatus)
    : "planned";

const normalizeOutput = (
  value: unknown,
  allowedSessionIds: Set<string>,
): ProjectMapNodeOutput | null => {
  if (!isRecord(value)) return null;
  const sessionId = normalizeString(value.sessionId);
  if (!sessionId || !allowedSessionIds.has(sessionId)) return null;
  return {
    artifactIds: normalizeStringList(value.artifactIds),
    messageId: normalizeString(value.messageId),
    sessionId,
    summary: typeof value.summary === "string" ? value.summary.trim() : "",
    updatedAt: normalizeString(value.updatedAt),
  };
};

const hasPath = (
  edges: ProjectMapEdge[],
  sourceNodeId: string,
  targetNodeId: string,
) => {
  const targetsBySource = new Map<string, string[]>();
  edges.forEach((edge) => {
    targetsBySource.set(edge.sourceNodeId, [
      ...(targetsBySource.get(edge.sourceNodeId) ?? []),
      edge.targetNodeId,
    ]);
  });
  const queue = [sourceNodeId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetNodeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(targetsBySource.get(current) ?? []));
  }
  return false;
};

export const wouldCreateProjectMapCycle = (
  map: Pick<ProjectMap, "edges">,
  sourceNodeId: string,
  targetNodeId: string,
) => sourceNodeId === targetNodeId || hasPath(map.edges, targetNodeId, sourceNodeId);

export const createEmptyProjectMap = (): ProjectMap => ({
  edges: [],
  nodes: [],
  version: PROJECT_MAP_VERSION,
});

export const normalizeProjectMap = (value: unknown): ProjectMap => {
  if (!isRecord(value)) return createEmptyProjectMap();

  const rawNodes = Array.isArray(value.nodes) ? value.nodes : [];
  const nodes: ProjectMapNode[] = [];
  const seenNodeIds = new Set<string>();
  const claimedSessionIds = new Set<string>();

  for (const rawNode of rawNodes) {
    if (!isRecord(rawNode)) continue;
    const id = normalizeString(rawNode.id);
    const title = normalizeString(rawNode.title);
    if (!id || !title || seenNodeIds.has(id)) continue;

    const sessionIds = normalizeStringList(rawNode.sessionIds).filter((sessionId) => {
      if (claimedSessionIds.has(sessionId)) return false;
      claimedSessionIds.add(sessionId);
      return true;
    });
    const allowedSessionIds = new Set(sessionIds);
    const requestedPrimarySessionId = normalizeString(rawNode.primarySessionId);
    const primarySessionId =
      requestedPrimarySessionId && allowedSessionIds.has(requestedPrimarySessionId)
        ? requestedPrimarySessionId
        : sessionIds[0] ?? null;

    nodes.push({
      description: typeof rawNode.description === "string" ? rawNode.description.trim() : "",
      id,
      primarySessionId,
      selectedOutput: normalizeOutput(rawNode.selectedOutput, allowedSessionIds),
      sessionIds,
      status: normalizeNodeStatus(rawNode.status),
      title,
    });
    seenNodeIds.add(id);
  }

  const rawEdges = Array.isArray(value.edges) ? value.edges : [];
  const edges: ProjectMapEdge[] = [];
  const seenEdgeIds = new Set<string>();
  for (const rawEdge of rawEdges) {
    if (!isRecord(rawEdge)) continue;
    const sourceNodeId = normalizeString(rawEdge.sourceNodeId);
    const targetNodeId = normalizeString(rawEdge.targetNodeId);
    if (!sourceNodeId || !targetNodeId) continue;
    if (!seenNodeIds.has(sourceNodeId) || !seenNodeIds.has(targetNodeId)) continue;
    if (sourceNodeId === targetNodeId) continue;
    const id = normalizeString(rawEdge.id) ?? `${sourceNodeId}=>${targetNodeId}`;
    if (seenEdgeIds.has(id)) continue;
    if (wouldCreateProjectMapCycle({ edges }, sourceNodeId, targetNodeId)) continue;
    edges.push({
      id,
      label: normalizeString(rawEdge.label),
      sourceNodeId,
      targetNodeId,
    });
    seenEdgeIds.add(id);
  }

  return {
    edges,
    nodes,
    version: PROJECT_MAP_VERSION,
  };
};

export const filterProjectMapSessions = (
  value: unknown,
  allowedSessionIds: ReadonlySet<string>,
): ProjectMap => {
  const map = normalizeProjectMap(value);
  return {
    ...map,
    nodes: map.nodes.map((node) => {
      const sessionIds = node.sessionIds.filter((sessionId) => allowedSessionIds.has(sessionId));
      const primarySessionId =
        node.primarySessionId && sessionIds.includes(node.primarySessionId)
          ? node.primarySessionId
          : sessionIds[0] ?? null;
      const selectedOutput =
        node.selectedOutput && sessionIds.includes(node.selectedOutput.sessionId)
          ? node.selectedOutput
          : null;
      return {
        ...node,
        primarySessionId,
        selectedOutput,
        sessionIds,
      };
    }),
  };
};

export const getProjectMapSessionIds = (map: ProjectMap) =>
  [...new Set(map.nodes.flatMap((node) => node.sessionIds))];

export const getProjectMapNode = (map: ProjectMap, nodeId: string) =>
  map.nodes.find((node) => node.id === nodeId) ?? null;

export const getProjectMapUpstreamNodes = (map: ProjectMap, nodeId: string) => {
  const sourceIds = new Set(
    map.edges.filter((edge) => edge.targetNodeId === nodeId).map((edge) => edge.sourceNodeId),
  );
  return map.nodes.filter((node) => sourceIds.has(node.id));
};

export const buildProjectMapInputSummary = (map: ProjectMap, nodeId: string) =>
  getProjectMapUpstreamNodes(map, nodeId)
    .flatMap((node) => {
      const output = node.selectedOutput;
      if (!output) return [];
      const body = output.summary.trim();
      return [
        `## ${node.title}\nSession: ${output.sessionId}${output.messageId ? ` · Message: ${output.messageId}` : ""}${body ? `\n${body}` : ""}`,
      ];
    })
    .join("\n\n");

export const buildLegacyProjectMap = (
  sessionIds: string[],
  sessionTitles: ReadonlyMap<string, string | null>,
): ProjectMap => {
  const normalizedSessionIds = [...new Set(sessionIds.filter((entry) => entry.length > 0))];
  const nodes = normalizedSessionIds.map<ProjectMapNode>((sessionId, index) => ({
    description: "Legacy project session. Assign this session to a workload node to refine the project map.",
    id: `session-${sessionId}`,
    primarySessionId: sessionId,
    selectedOutput: null,
    sessionIds: [sessionId],
    status: "ready",
    title: sessionTitles.get(sessionId)?.trim() || `Workload ${index + 1}`,
  }));

  return {
    edges: nodes.slice(1).map((node, index) => ({
      id: `${nodes[index]!.id}=>${node.id}`,
      label: null,
      sourceNodeId: nodes[index]!.id,
      targetNodeId: node.id,
    })),
    nodes,
    version: PROJECT_MAP_VERSION,
  };
};
