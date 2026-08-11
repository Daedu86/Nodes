"use client";

import type { ProjectMemoryItem } from "@/lib/memory-documents";
import type { ProjectDocument } from "@/lib/project-documents";
import { buildLegacyProjectMap, normalizeProjectMap } from "@/lib/project-map";
import type { SessionDocument } from "@/lib/session-documents";
import { getSessionTreeStats } from "@/lib/session-context";
import { layoutThreadGraphFlow } from "@/components/assistant-ui/thread-graph-flow/thread-graph-layout";
import type {
  ThreadGraphFlowEdge,
  ThreadGraphFlowNode,
} from "@/components/assistant-ui/thread-graph-flow/thread-graph-flow-types";

const WORKLOAD_SWATCHES = [
  "#2563eb",
  "#0f766e",
  "#7c3aed",
  "#ea580c",
  "#db2777",
  "#059669",
  "#9333ea",
  "#0891b2",
];

const STATUS_ACCENTS: Record<string, string> = {
  active: "#0284c7",
  blocked: "#dc2626",
  complete: "#16a34a",
  planned: "#64748b",
  ready: "#7c3aed",
};

const NODE_TYPE_ACCENTS: Record<string, string> = {
  iteration: "#4f46e5",
  iteration_result: "#d97706",
  final_submission: "#0891b2",
};

const NODE_TYPE_ROLES: Record<string, string> = {
  iteration: "Iteration",
  iteration_result: "Iteration result",
  final_submission: "Final submission",
  workload: "workload",
};

const formatSessionTitle = (title: string | null) => title?.trim() || "Untitled Session";

const makeWorkloadNodeId = (projectId: string, mapNodeId: string) =>
  `project:${projectId}:workload:${mapNodeId}`;

const summarizeNodeSessions = (sessions: SessionDocument[]) => {
  if (sessions.length === 0) return "No sessions yet";
  const messageCount = sessions.reduce(
    (total, session) => total + getSessionTreeStats(session.snapshot).messageCount,
    0,
  );
  const artifactCount = sessions.reduce(
    (total, session) =>
      total + session.artifacts.filter((artifact) => artifact.artifactType !== "prompt").length,
    0,
  );
  return `${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${messageCount} messages · ${artifactCount} artifacts`;
};

export function buildProjectCanvasFlow(
  project: ProjectDocument,
  sessions: SessionDocument[],
  memoryItems: ProjectMemoryItem[] = [],
) {
  void memoryItems;
  const nodes: ThreadGraphFlowNode[] = [];
  const edges: ThreadGraphFlowEdge[] = [];
  const sessionById = new Map(sessions.map((session) => [session.id, session] as const));
  const sessionTitleById = new Map(
    sessions.map((session) => [session.id, session.title] as const),
  );
  const persistedMap = normalizeProjectMap(project.map);
  const map = persistedMap.nodes.length > 0
    ? persistedMap
    : buildLegacyProjectMap(project.sessionIds, sessionTitleById);

  map.nodes.forEach((mapNode, index) => {
    const nodeSessions = mapNode.sessionIds
      .map((sessionId) => sessionById.get(sessionId))
      .filter((session): session is SessionDocument => Boolean(session));
    const primarySession = mapNode.primarySessionId
      ? sessionById.get(mapNode.primarySessionId) ?? null
      : nodeSessions[0] ?? null;
    const output = mapNode.selectedOutput;
    const nodeType = mapNode.nodeType ?? "workload";
    const accent = NODE_TYPE_ACCENTS[nodeType]
      ?? STATUS_ACCENTS[mapNode.status]
      ?? WORKLOAD_SWATCHES[index % WORKLOAD_SWATCHES.length]
      ?? "#2563eb";
    const description = mapNode.description.trim();
    const outputPreview = output?.summary.trim()
      ? `Output: ${output.summary.trim()}`
      : output
        ? `Output selected from ${formatSessionTitle(sessionById.get(output.sessionId)?.title ?? null)}`
        : "No output selected yet";
    const hierarchyPreview = mapNode.childProjectId
      ? `Child canvas: ${mapNode.childProjectId}`
      : mapNode.terminalResult
        ? "Terminal external evaluation for this iteration"
        : null;

    nodes.push({
      id: makeWorkloadNodeId(project.id, mapNode.id),
      type: "threadNode",
      position: { x: 0, y: 0 },
      data: {
        accent,
        idx: index,
        kind: "message",
        mapNodeId: mapNode.id,
        messageId: output?.messageId ?? null,
        preview: [
          nodeType === "iteration_result" ? "ITERATION RESULT" : null,
          nodeType === "final_submission" ? "PROJECT FINAL SUBMISSION" : null,
          description || "Workload / thinking node",
          hierarchyPreview,
          summarizeNodeSessions(nodeSessions),
          outputPreview,
        ].filter(Boolean).join("\n\n"),
        role: NODE_TYPE_ROLES[nodeType] ?? "workload",
        sessionId: primarySession?.id ?? null,
        sessionIds: mapNode.sessionIds,
        sessionTitle:
          nodeSessions.length === 0
            ? null
            : nodeSessions.length === 1
              ? formatSessionTitle(nodeSessions[0]!.title)
              : `${nodeSessions.length} sessions`,
        statusLabel: mapNode.status,
        title: mapNode.title,
      },
    });
  });

  map.edges.forEach((mapEdge) => {
    const sourceNode = map.nodes.find((node) => node.id === mapEdge.sourceNodeId);
    if (!sourceNode) return;
    const sourceType = sourceNode.nodeType ?? "workload";
    edges.push({
      id: `project:${project.id}:edge:${mapEdge.id}`,
      source: makeWorkloadNodeId(project.id, mapEdge.sourceNodeId),
      target: makeWorkloadNodeId(project.id, mapEdge.targetNodeId),
      type: "threadEdge",
      data: {
        accent: NODE_TYPE_ACCENTS[sourceType]
          ?? (sourceNode.selectedOutput ? "#16a34a" : "#64748b"),
        label: mapEdge.label ?? (sourceNode.selectedOutput ? "output" : "depends on"),
        tone: "default",
      },
    });
  });

  return layoutThreadGraphFlow(nodes, edges);
}
