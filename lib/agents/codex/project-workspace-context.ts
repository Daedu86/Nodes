import type { ProjectMap } from "@/lib/project-map";

export type ProjectWorkspaceArtifactRef = {
  artifactIds: string[];
  nodeId: string;
  sessionId: string;
};

export const getSelectedAncestorArtifactRefs = (
  map: ProjectMap,
  targetNodeId: string,
): ProjectWorkspaceArtifactRef[] => {
  const incomingByTarget = new Map<string, string[]>();
  for (const edge of map.edges) {
    incomingByTarget.set(edge.targetNodeId, [
      ...(incomingByTarget.get(edge.targetNodeId) ?? []),
      edge.sourceNodeId,
    ]);
  }

  const ancestorIds = new Set<string>();
  const queue = [...(incomingByTarget.get(targetNodeId) ?? [])];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (ancestorIds.has(nodeId)) continue;
    ancestorIds.add(nodeId);
    queue.push(...(incomingByTarget.get(nodeId) ?? []));
  }

  return map.nodes.flatMap((node) => {
    if (!ancestorIds.has(node.id) || !node.selectedOutput) return [];
    const artifactIds = [...new Set(node.selectedOutput.artifactIds)];
    if (artifactIds.length === 0) return [];
    return [{
      artifactIds,
      nodeId: node.id,
      sessionId: node.selectedOutput.sessionId,
    }];
  });
};
