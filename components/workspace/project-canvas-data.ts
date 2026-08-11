"use client";

import { normalizeMessageContent } from "@/lib/llm/messages";
import type { ProjectMemoryItem } from "@/lib/memory-documents";
import {
  PROJECT_MEMORY_META,
  PROJECT_MEMORY_TYPE_ORDER,
} from "@/lib/project-memory-meta";
import { PROJECT_MAP_FILENAME, type ProjectDocument } from "@/lib/project-documents";
import type { SessionDocument } from "@/lib/session-documents";
import { getSessionTreeStats } from "@/lib/session-context";
import {
  layoutThreadGraphFlow,
} from "@/components/assistant-ui/thread-graph-flow/thread-graph-layout";
import type {
  ThreadGraphFlowEdge,
  ThreadGraphFlowNode,
} from "@/components/assistant-ui/thread-graph-flow/thread-graph-flow-types";

const SESSION_SWATCHES = [
  "#2563eb",
  "#0f766e",
  "#7c3aed",
  "#ea580c",
  "#db2777",
  "#059669",
  "#9333ea",
  "#0891b2",
];
const PROJECT_MAP_ACCENT = "#d97706";

const formatSessionTitle = (title: string | null) => title?.trim() || "Untitled Session";

const getMessageId = (value: unknown, fallback: string) =>
  typeof value === "string" && value.length > 0 ? value : fallback;

const getMessageRole = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : "message";

const getCustomMetadata = (value: unknown) => {
  if (typeof value !== "object" || value === null) return {};
  const metadata = value as { metadata?: { custom?: Record<string, unknown> } };
  return metadata.metadata?.custom ?? {};
};

const makeSessionNodeId = (projectId: string, sessionId: string) =>
  `project:${projectId}:session:${sessionId}`;

const makeMessageNodeId = (projectId: string, sessionId: string, messageId: string) =>
  `project:${projectId}:session:${sessionId}:message:${messageId}`;

const makeContextNodeId = (projectId: string) => `project:${projectId}:context`;
const makeMemoryNodeId = (projectId: string, memoryId: string) => `project:${projectId}:memory:${memoryId}`;

const resolveMemorySourceNodeIds = (
  projectId: string,
  memoryItem: ProjectMemoryItem,
) => {
  if (memoryItem.sourceKind === "session") {
    return memoryItem.sourceKeys.map((sessionId) => makeSessionNodeId(projectId, sessionId));
  }
  if (memoryItem.sourceKind === "branch") {
    return memoryItem.sourceKeys
      .map((sourceKey) => {
        const [sessionId, messageId] = sourceKey.split(":");
        if (!sessionId || !messageId) return null;
        return makeMessageNodeId(projectId, sessionId, messageId);
      })
      .filter((value): value is string => Boolean(value));
  }
  return [];
};

export function buildProjectCanvasFlow(
  project: ProjectDocument,
  sessions: SessionDocument[],
  memoryItems: ProjectMemoryItem[] = [],
) {
  const nodes: ThreadGraphFlowNode[] = [];
  const edges: ThreadGraphFlowEdge[] = [];
  const orderedSessions = project.sessionIds
    .map((sessionId) => sessions.find((session) => session.id === sessionId))
    .filter((session): session is SessionDocument => Boolean(session));

  const globalContextNodeId = makeContextNodeId(project.id);
  const memoryLaneCounts = new Map<string, number>();
  const mergeLaneIndexRef = { value: 0 };
  nodes.push({
    id: globalContextNodeId,
    type: "artifactNode",
    position: { x: -420, y: 48 },
    data: {
      accent: PROJECT_MAP_ACCENT,
      artifactType: "text",
      kind: "artifact",
      linkedArtifactCount: orderedSessions.length,
      preview: project.globalContext,
      role: "global-context",
      statusLabel: `${PROJECT_MAP_FILENAME} · base of project`,
      title: project.title?.trim() ? `${project.title} Map` : "Project Map",
    },
  });

  memoryItems.forEach((memoryItem) => {
    const memoryNodeId = makeMemoryNodeId(project.id, memoryItem.id);
    const sourceSession = memoryItem.sourceSessionId
      ? orderedSessions.find((session) => session.id === memoryItem.sourceSessionId) ?? null
      : null;
    const memoryMeta = PROJECT_MEMORY_META[memoryItem.type];
    const laneIndex = PROJECT_MEMORY_TYPE_ORDER.indexOf(memoryItem.type);
    const laneCount = memoryLaneCounts.get(memoryItem.type) ?? 0;
    memoryLaneCounts.set(memoryItem.type, laneCount + 1);
    const position =
      memoryItem.type === "merge"
        ? { x: -560, y: 72 + mergeLaneIndexRef.value++ * 240 }
        : {
            x: -900,
            y: 56 + Math.max(0, laneIndex) * 176 + laneCount * 44,
          };

    nodes.push({
      id: memoryNodeId,
      type: "artifactNode",
      position,
      data: {
        accent:
          memoryItem.type === "merge"
            ? memoryMeta.accent
            : sourceSession
              ? SESSION_SWATCHES[orderedSessions.findIndex((session) => session.id === sourceSession.id) % SESSION_SWATCHES.length]
              : memoryMeta.accent,
        artifactType: "text",
        kind: "artifact",
        memoryId: memoryItem.id,
        memoryType: memoryItem.type,
        preview: memoryItem.content,
        role: "memory",
        sessionId: memoryItem.sourceSessionId,
        sessionTitle: sourceSession ? formatSessionTitle(sourceSession.title) : null,
        statusLabel:
          memoryItem.type === "merge"
            ? "merge node"
            : sourceSession
              ? `${memoryMeta.label.toLowerCase()} · linked session`
              : `${memoryMeta.label.toLowerCase()} · library`,
        title: memoryItem.title,
      },
    });

    edges.push({
      id: `${memoryNodeId}=>${globalContextNodeId}`,
      source: memoryNodeId,
      target: globalContextNodeId,
      type: "threadEdge",
      data: {
        accent: memoryMeta.accent,
        label: memoryMeta.label.toLowerCase(),
        tone: "context",
      },
    });

    if (memoryItem.type === "merge") {
      resolveMemorySourceNodeIds(project.id, memoryItem).forEach((sourceNodeId) => {
        edges.push({
          id: `${sourceNodeId}=>${memoryNodeId}`,
          source: sourceNodeId,
          target: memoryNodeId,
          type: "threadEdge",
          data: {
            accent: "#d97706",
            label: "merge",
            tone: "edited",
          },
        });
      });
    }
  });

  orderedSessions.forEach((session, sessionIndex) => {
    const isArenaWinner = project.arenaWinnerSessionId === session.id;
    const sessionColor = isArenaWinner
      ? "#d97706"
      : SESSION_SWATCHES[sessionIndex % SESSION_SWATCHES.length] ?? "#2563eb";
    const sessionNodeId = makeSessionNodeId(project.id, session.id);
    const sessionStats = getSessionTreeStats(session.snapshot);
    const sessionTitle = formatSessionTitle(session.title);

    nodes.push({
      id: sessionNodeId,
      type: "threadNode",
      position: { x: 0, y: 0 },
      data: {
        accent: sessionColor,
        idx: sessionIndex,
        kind: "message",
        preview: [
          isArenaWinner ? "Arena winner" : null,
          `${sessionStats.messageCount} messages`,
          `${sessionStats.rootCount} root branches`,
          `${sessionStats.siblingGroups} branching points`,
          `${session.artifacts.filter((artifact) => artifact.artifactType !== "prompt").length} artifacts`,
        ].filter(Boolean).join(" · "),
        role: "session",
        sessionId: session.id,
        sessionTitle,
        statusLabel: isArenaWinner ? "Arena winner" : null,
        title: sessionTitle,
      },
    });

    edges.push({
      id: `${globalContextNodeId}=>${sessionNodeId}`,
      source: globalContextNodeId,
      target: sessionNodeId,
      type: "threadEdge",
      data: {
        accent: sessionColor,
        label: "map",
        tone: "context",
      },
    });

    session.snapshot.messages.forEach((entry, messageIndex) => {
      const message = entry.message ?? {};
      const messageId = getMessageId(
        (message as { id?: unknown }).id,
        `message-${messageIndex + 1}`,
      );
      const isBranchWinner = project.arenaWinnerBranchKey === `${session.id}:${messageId}`;
      const messageNodeId = makeMessageNodeId(project.id, session.id, messageId);
      const normalizedContent =
        normalizeMessageContent((message as { parts?: unknown }).parts) ??
        normalizeMessageContent((message as { content?: unknown }).content);
      const metadataCustom = getCustomMetadata(message);

      nodes.push({
        id: messageNodeId,
        type: "threadNode",
        position: { x: 0, y: 0 },
        data: {
          accent: isBranchWinner ? "#d97706" : sessionColor,
          idx: messageIndex,
          kind: "message",
          linkedArtifactCount: session.contextLinks.filter((link) => link.targetMessageId === messageId).length,
          messageId,
          model: typeof metadataCustom.model === "string" ? metadataCustom.model : null,
          preview:
            normalizedContent?.content.trim() ||
            (getMessageRole((message as { role?: unknown }).role) === "assistant"
              ? "Assistant message with no text preview."
              : "User message with no text preview."),
          provider: typeof metadataCustom.provider === "string" ? metadataCustom.provider : null,
          role: getMessageRole((message as { role?: unknown }).role),
          sessionId: session.id,
          sessionTitle,
          statusLabel: isBranchWinner ? "Arena winner" : null,
          title: sessionTitle,
        },
      });

      const parentNodeId = entry.parentId
        ? makeMessageNodeId(project.id, session.id, entry.parentId)
        : sessionNodeId;
      edges.push({
        id: `${parentNodeId}=>${messageNodeId}`,
        source: parentNodeId,
        target: messageNodeId,
        type: "threadEdge",
        data: {
          accent: sessionColor,
          tone: "default",
        },
      });
    });
  });

  return layoutThreadGraphFlow(nodes, edges);
}
