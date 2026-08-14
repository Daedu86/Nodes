"use client";

import React from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeMouseHandler,
  type NodeMouseHandler,
  type NodeProps,
} from "@xyflow/react";
import {
  Activity,
  CheckCircle2,
  ExternalLink,
  Layers3,
  Plus,
  RefreshCw,
  Route,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { ThreadGraphEdge } from "@/components/assistant-ui/thread-graph-flow/thread-graph-edge";
import { usePersistedSessions } from "@/components/context/persisted-sessions";
import { useProjects } from "@/components/context/projects";
import type { ProjectDocument } from "@/lib/project-documents";
import type { ProjectMemoryItem } from "@/lib/memory-documents";
import {
  buildLegacyProjectMap,
  normalizeProjectMap,
  wouldCreateProjectMapCycle,
  type ProjectMap,
  type ProjectMapNodeStatus,
} from "@/lib/project-map";
import { normalizeMessageContent } from "@/lib/llm/messages";
import type { SessionDocument } from "@/lib/session-documents";
import type {
  ThreadGraphFlowEdge,
  ThreadGraphFlowNode,
} from "@/components/assistant-ui/thread-graph-flow/thread-graph-flow-types";
import { buildProjectCanvasFlow } from "@/components/workspace/project-canvas-data";

export type ProjectCanvasSelection =
  | {
      kind: "edge";
      label: string;
      preview: string;
      sessionId: string | null;
    }
  | {
      kind: "node";
      label: string;
      mapNodeId?: string | null;
      messageId?: string | null;
      memoryId?: string | null;
      memoryType?: string | null;
      preview: string;
      role: string;
      sessionId: string | null;
      sessionIds?: string[];
      sessionTitle: string | null;
    }
  | null;

type ProjectCanvasFilter = "all" | "active" | "complete" | "blocked";

const PROJECT_CANVAS_FILTER_META: Record<
  ProjectCanvasFilter,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  all: { label: "All workloads", icon: Layers3 },
  active: { label: "Active", icon: Activity },
  complete: { label: "Complete", icon: CheckCircle2 },
  blocked: { label: "Blocked", icon: ShieldAlert },
};

const PROJECT_MAP_STATUS_OPTIONS: ProjectMapNodeStatus[] = [
  "planned",
  "ready",
  "active",
  "complete",
  "blocked",
];

const matchesCanvasFilter = (node: ThreadGraphFlowNode, filter: ProjectCanvasFilter) => {
  if (filter === "all") return true;
  return node.data.statusLabel === filter;
};

const getRoleLabel = (node: ThreadGraphFlowNode) => {
  if (node.data.role === "workload") return "Workload";
  if (node.data.role === "global-context") return "Project context";
  if (node.data.role === "memory") return "Typed node";
  if (node.data.role === "assistant") return "Assistant";
  if (node.data.role === "user") return "Prompt";
  return node.data.role || "Node";
};

const makeWorkloadId = () => {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `workload-${crypto.randomUUID()}`;
  }
  return `workload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

const makeDependencyId = (sourceNodeId: string, targetNodeId: string) =>
  `${sourceNodeId}=>${targetNodeId}`;

const getLatestSessionOutput = (session: SessionDocument) => {
  for (let index = session.snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = session.snapshot.messages[index]?.message;
    if (!message || message.role !== "assistant") continue;
    const normalized =
      normalizeMessageContent(message.parts) ?? normalizeMessageContent(message.content);
    const summary = normalized?.textContent.trim() || normalized?.content.trim() || "";
    if (!summary) continue;
    return {
      artifactIds: session.artifacts
        .filter((artifact) => artifact.artifactType !== "prompt")
        .map((artifact) => artifact.id),
      messageId: typeof message.id === "string" ? message.id : null,
      sessionId: session.id,
      summary: summary.slice(0, 6000),
      updatedAt: new Date().toISOString(),
    };
  }
  return null;
};

const ProjectCanvasNode = React.memo(
  ({ data, selected }: NodeProps<ThreadGraphFlowNode>) => {
    const accent = data.accent ?? "#64748b";
    const title = data.title ?? data.sessionTitle ?? getRoleLabel({ data } as ThreadGraphFlowNode);
    const preview = data.preview.trim() || "No content";

    return (
      <div
        className={[
          "relative w-[340px] max-w-[min(340px,calc(100vw-3rem))] rounded-2xl border bg-slate-950/95 p-4 text-slate-100 shadow-xl",
          selected ? "ring-2 ring-sky-400/70" : "ring-1 ring-white/10",
        ].join(" ")}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!h-3 !w-3 !border-2 !border-slate-950 !bg-slate-300/90"
          style={{ left: -7 }}
        />
        <Handle
          type="source"
          position={Position.Right}
          className="!h-3 !w-3 !border-2 !border-slate-950 !bg-slate-300/90"
          style={{ right: -7 }}
        />

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ borderColor: `${accent}55`, backgroundColor: `${accent}22`, color: accent }}
              >
                {getRoleLabel({ data } as ThreadGraphFlowNode)}
              </span>
              {data.statusLabel ? (
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-slate-300">
                  {data.statusLabel}
                </span>
              ) : null}
              {data.sessionTitle ? (
                <span className="truncate text-xs text-slate-300">{data.sessionTitle}</span>
              ) : null}
            </div>
            <h3 className="mt-2 truncate text-sm font-semibold text-white">{title}</h3>
          </div>
        </div>

        <p className="mt-3 max-h-40 overflow-hidden whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm leading-6 text-slate-200">
          {preview}
        </p>
      </div>
    );
  },
);

ProjectCanvasNode.displayName = "ProjectCanvasNode";

const nodeTypes = {
  artifactNode: ProjectCanvasNode,
  threadNode: ProjectCanvasNode,
};

const edgeTypes = {
  threadEdge: ThreadGraphEdge,
};

function ProjectCanvasInner({
  project,
  sessions,
  memoryItems,
  onSelectionChange,
}: {
  project: ProjectDocument;
  sessions: SessionDocument[];
  memoryItems: ProjectMemoryItem[];
  onSelectionChange?: (selection: ProjectCanvasSelection) => void;
}) {
  const reactFlow = useReactFlow<ThreadGraphFlowNode, ThreadGraphFlowEdge>();
  const { clearActiveProject, saveActiveProjectPatch } = useProjects();
  const { sessions: allSessionSummaries } = usePersistedSessions();
  const sessionTitleById = React.useMemo(
    () => new Map(allSessionSummaries.map((session) => [session.id, session.title] as const)),
    [allSessionSummaries],
  );
  const persistedMap = React.useMemo(() => normalizeProjectMap(project.map), [project.map]);
  const effectiveMap = React.useMemo<ProjectMap>(
    () => persistedMap.nodes.length > 0
      ? persistedMap
      : buildLegacyProjectMap(project.sessionIds, sessionTitleById),
    [persistedMap, project.sessionIds, sessionTitleById],
  );
  const flow = React.useMemo(
    () => buildProjectCanvasFlow({ ...project, map: effectiveMap }, sessions, memoryItems),
    [effectiveMap, memoryItems, project, sessions],
  );
  const nodes = React.useMemo(
    () => flow.nodes.map((node) => ({ ...node, draggable: false })) satisfies ThreadGraphFlowNode[],
    [flow.nodes],
  );
  const edges = React.useMemo(
    () => flow.edges.map((edge) => ({ ...edge, selectable: true })) satisfies ThreadGraphFlowEdge[],
    [flow.edges],
  );
  const [canvasFilter, setCanvasFilter] = React.useState<ProjectCanvasFilter>("all");
  const [localSelection, setLocalSelection] = React.useState<ProjectCanvasSelection>(null);
  const [guideOpen, setGuideOpen] = React.useState(false);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [sessionToAttach, setSessionToAttach] = React.useState("");
  const [dependencyTargetId, setDependencyTargetId] = React.useState("");
  React.useEffect(() => {
    setCanvasFilter("all");
    setLocalSelection(null);
    setGuideOpen(false);
    setEditorOpen(false);
    setSessionToAttach("");
    setDependencyTargetId("");
  }, [project.id]);

  const selectedMapNodeId =
    localSelection?.kind === "node" ? localSelection.mapNodeId ?? null : null;
  const selectedMapNode = React.useMemo(
    () => effectiveMap.nodes.find((node) => node.id === selectedMapNodeId) ?? null,
    [effectiveMap.nodes, selectedMapNodeId],
  );
  const claimedSessionIds = React.useMemo(
    () => new Set(effectiveMap.nodes.flatMap((node) => node.sessionIds)),
    [effectiveMap.nodes],
  );
  const attachableSessions = React.useMemo(
    () => allSessionSummaries.filter((session) => !claimedSessionIds.has(session.id)),
    [allSessionSummaries, claimedSessionIds],
  );
  const selectedNodeSessions = React.useMemo(
    () => selectedMapNode
      ? selectedMapNode.sessionIds
        .map((sessionId) => sessions.find((session) => session.id === sessionId) ?? null)
        .filter((session): session is SessionDocument => session !== null)
      : [],
    [selectedMapNode, sessions],
  );

  const saveMap = React.useCallback(async (map: ProjectMap) => {
    await saveActiveProjectPatch({ map: normalizeProjectMap(map) });
  }, [saveActiveProjectPatch]);

  const updateSelectedMapNode = React.useCallback(async (
    update: (node: NonNullable<typeof selectedMapNode>) => NonNullable<typeof selectedMapNode>,
  ) => {
    if (!selectedMapNode) return;
    await saveMap({
      ...effectiveMap,
      nodes: effectiveMap.nodes.map((node) =>
        node.id === selectedMapNode.id ? update(node) : node,
      ),
    });
  }, [effectiveMap, saveMap, selectedMapNode]);

  const handleCreateWorkload = React.useCallback(async () => {
    if (project.accessRole !== "owner") return;
    const title = window.prompt("Name this workload / thinking node");
    if (!title?.trim()) return;
    const description = window.prompt("What should this workload accomplish?", "") ?? "";
    const id = makeWorkloadId();
    await saveMap({
      ...effectiveMap,
      nodes: [
        ...effectiveMap.nodes,
        {
          description: description.trim(),
          id,
          primarySessionId: null,
          selectedOutput: null,
          sessionIds: [],
          status: "planned",
          title: title.trim(),
        },
      ],
    });
  }, [effectiveMap, project.accessRole, saveMap]);

  const handleAttachSession = React.useCallback(async () => {
    if (!selectedMapNode || !sessionToAttach) return;
    await updateSelectedMapNode((node) => ({
      ...node,
      primarySessionId: node.primarySessionId ?? sessionToAttach,
      sessionIds: [...node.sessionIds, sessionToAttach],
      status: node.status === "planned" ? "ready" : node.status,
    }));
    setSessionToAttach("");
  }, [selectedMapNode, sessionToAttach, updateSelectedMapNode]);

  const handleDetachSession = React.useCallback(async (sessionId: string) => {
    if (!selectedMapNode) return;
    await updateSelectedMapNode((node) => {
      const sessionIds = node.sessionIds.filter((entry) => entry !== sessionId);
      return {
        ...node,
        primarySessionId:
          node.primarySessionId === sessionId ? sessionIds[0] ?? null : node.primarySessionId,
        selectedOutput:
          node.selectedOutput?.sessionId === sessionId ? null : node.selectedOutput,
        sessionIds,
        status: sessionIds.length === 0 && node.status === "ready" ? "planned" : node.status,
      };
    });
  }, [selectedMapNode, updateSelectedMapNode]);

  const handlePublishOutput = React.useCallback(async () => {
    if (!selectedMapNode?.primarySessionId) return;
    const session = selectedNodeSessions.find(
      (entry) => entry.id === selectedMapNode.primarySessionId,
    );
    if (!session) return;
    const output = getLatestSessionOutput(session);
    if (!output) {
      window.alert("This session has no assistant result to publish yet.");
      return;
    }
    await updateSelectedMapNode((node) => ({
      ...node,
      selectedOutput: output,
      status: "complete",
    }));
  }, [selectedMapNode, selectedNodeSessions, updateSelectedMapNode]);

  const handleAddDependency = React.useCallback(async () => {
    if (!selectedMapNode || !dependencyTargetId) return;
    if (wouldCreateProjectMapCycle(effectiveMap, selectedMapNode.id, dependencyTargetId)) {
      window.alert("That connection would create a circular project dependency.");
      return;
    }
    if (effectiveMap.edges.some(
      (edge) => edge.sourceNodeId === selectedMapNode.id && edge.targetNodeId === dependencyTargetId,
    )) return;
    await saveMap({
      ...effectiveMap,
      edges: [
        ...effectiveMap.edges,
        {
          id: makeDependencyId(selectedMapNode.id, dependencyTargetId),
          label: null,
          sourceNodeId: selectedMapNode.id,
          targetNodeId: dependencyTargetId,
        },
      ],
    });
    setDependencyTargetId("");
  }, [dependencyTargetId, effectiveMap, saveMap, selectedMapNode]);

  const handleRemoveDependency = React.useCallback(async (edgeId: string) => {
    await saveMap({
      ...effectiveMap,
      edges: effectiveMap.edges.filter((edge) => edge.id !== edgeId),
    });
  }, [effectiveMap, saveMap]);

  const handleDeleteWorkload = React.useCallback(async () => {
    if (!selectedMapNode) return;
    if (!window.confirm(`Delete workload “${selectedMapNode.title}” from the project map?`)) return;
    await saveMap({
      ...effectiveMap,
      nodes: effectiveMap.nodes.filter((node) => node.id !== selectedMapNode.id),
      edges: effectiveMap.edges.filter(
        (edge) => edge.sourceNodeId !== selectedMapNode.id && edge.targetNodeId !== selectedMapNode.id,
      ),
    });
    setLocalSelection(null);
    onSelectionChange?.(null);
  }, [effectiveMap, onSelectionChange, saveMap, selectedMapNode]);

  const handleOpenSession = React.useCallback((sessionId: string) => {
    clearActiveProject();
    window.location.assign(`/?sessionId=${encodeURIComponent(sessionId)}`);
  }, [clearActiveProject]);

  const filterCounts = React.useMemo(
    () => ({
      all: nodes.length,
      active: nodes.filter((node) => matchesCanvasFilter(node, "active")).length,
      blocked: nodes.filter((node) => matchesCanvasFilter(node, "blocked")).length,
      complete: nodes.filter((node) => matchesCanvasFilter(node, "complete")).length,
    }),
    [nodes],
  );

  const visibleNodes = React.useMemo(
    () => nodes.filter((node) => matchesCanvasFilter(node, canvasFilter)),
    [canvasFilter, nodes],
  );
  const hasVisibleNodes = visibleNodes.length > 0;

  const visibleNodeIds = React.useMemo(
    () => new Set(visibleNodes.map((node) => node.id)),
    [visibleNodes],
  );
  const visibleEdges = React.useMemo(
    () => edges.filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)),
    [edges, visibleNodeIds],
  );

  React.useEffect(() => {
    if (!hasVisibleNodes) return;
    const timeout = window.setTimeout(() => {
      void reactFlow.fitView({
        duration: 250,
        padding: 0.2,
      });
    }, 80);
    return () => window.clearTimeout(timeout);
  }, [canvasFilter, hasVisibleNodes, project.id, reactFlow]);

  const handleNodeClick = React.useCallback<NodeMouseHandler<ThreadGraphFlowNode>>(
    (_, node) => {
      const selection: ProjectCanvasSelection = {
        kind: "node",
        label: node.data.title ?? node.data.sessionTitle ?? node.data.role,
        mapNodeId: node.data.mapNodeId ?? null,
        messageId: node.data.messageId ?? null,
        memoryId: node.data.memoryId ?? null,
        memoryType: node.data.memoryType ?? null,
        preview: node.data.preview,
        role: node.data.role,
        sessionId: node.data.sessionId ?? null,
        sessionIds: node.data.sessionIds ?? [],
        sessionTitle: node.data.sessionTitle ?? null,
      };
      setLocalSelection(selection);
      onSelectionChange?.(selection);
    },
    [onSelectionChange],
  );

  const handleEdgeClick = React.useCallback<EdgeMouseHandler<ThreadGraphFlowEdge>>(
    (_, edge) => {
      const selection: ProjectCanvasSelection = {
        kind: "edge",
        label: edge.data?.label ?? "Dependency",
        preview:
          "Workload dependency. The downstream node consumes the selected output exposed by the upstream workload node.",
        sessionId: null,
      };
      setLocalSelection(selection);
      onSelectionChange?.(selection);
    },
    [onSelectionChange],
  );

  const handlePaneClick = React.useCallback(() => {
    setLocalSelection(null);
    onSelectionChange?.(null);
  }, [onSelectionChange]);

  const handleResetView = React.useCallback(() => {
    setCanvasFilter("all");
    window.setTimeout(() => {
      void reactFlow.fitView({ duration: 250, padding: 0.2 });
    }, 60);
  }, [reactFlow]);

  const outgoingDependencies = selectedMapNode
    ? effectiveMap.edges.filter((edge) => edge.sourceNodeId === selectedMapNode.id)
    : [];
  const downstreamCandidates = selectedMapNode
    ? effectiveMap.nodes.filter((node) =>
      node.id !== selectedMapNode.id &&
      !effectiveMap.edges.some(
        (edge) => edge.sourceNodeId === selectedMapNode.id && edge.targetNodeId === node.id,
      ) &&
      !wouldCreateProjectMapCycle(effectiveMap, selectedMapNode.id, node.id),
    )
    : [];

  return (
    <div className="relative h-full w-full">
      <div className="pointer-events-none absolute left-4 top-4 z-10 flex items-start gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="pointer-events-auto h-8 px-3"
          onClick={() => setGuideOpen((value) => !value)}
        >
          <Route className="h-3.5 w-3.5" />
          {guideOpen ? "Hide map guide" : "Map guide"}
        </Button>
        {project.accessRole === "owner" ? (
          <Button
            type="button"
            variant={editorOpen ? "default" : "outline"}
            size="sm"
            className="pointer-events-auto h-8 px-3"
            onClick={() => setEditorOpen((value) => !value)}
          >
            {editorOpen ? "Hide editor" : "Edit map"}
          </Button>
        ) : null}
      </div>

      {guideOpen ? (
        <div className="pointer-events-none absolute left-4 top-14 z-10 w-[min(390px,calc(100%-2rem))]">
          <div className="rounded-2xl border border-border/70 bg-background/90 p-3 shadow-lg backdrop-blur-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  Project Map
                </p>
                <p className="text-sm font-medium text-foreground">
                  Project index and workload orchestration graph
                </p>
                <p className="text-xs leading-5 text-muted-foreground">
                  Each card is one thinking/workload node. A workload owns one or more sessions; its selected output flows along dependency edges to downstream workloads. Session message trees remain inside the workload.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="pointer-events-auto h-8 px-2"
                onClick={handleResetView}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reset view
              </Button>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {(Object.entries(PROJECT_CANVAS_FILTER_META) as Array<
                [ProjectCanvasFilter, (typeof PROJECT_CANVAS_FILTER_META)[ProjectCanvasFilter]]
              >).map(([filter, meta]) => {
                const Icon = meta.icon;
                return (
                  <Button
                    key={filter}
                    type="button"
                    variant={canvasFilter === filter ? "default" : "outline"}
                    size="sm"
                    className="pointer-events-auto h-8 px-3"
                    onClick={() => setCanvasFilter(filter)}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {meta.label}
                    <span className="rounded-full bg-black/10 px-1.5 py-0.5 text-[10px] leading-none text-current">
                      {filterCounts[filter]}
                    </span>
                  </Button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {editorOpen && project.accessRole === "owner" ? (
        <div className="pointer-events-auto absolute right-4 top-4 z-20 w-[min(390px,calc(100%-2rem))] max-h-[calc(100%-2rem)] overflow-y-auto rounded-2xl border border-border/70 bg-background/95 p-4 shadow-xl backdrop-blur-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">Map editor</p>
              <p className="mt-1 text-sm font-semibold text-foreground">Workloads own sessions</p>
            </div>
            <Button type="button" size="sm" variant="outline" onClick={() => void handleCreateWorkload()}>
              <Plus className="h-3.5 w-3.5" />
              Workload
            </Button>
          </div>

          {!selectedMapNode ? (
            <p className="mt-4 rounded-xl border border-dashed border-border/70 p-3 text-sm leading-6 text-muted-foreground">
              Select a workload card to manage its sessions, status, output, and downstream dependencies.
            </p>
          ) : (
            <div className="mt-4 space-y-4">
              <div className="rounded-xl border border-border/60 p-3">
                <p className="font-medium text-foreground">{selectedMapNode.title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {selectedMapNode.description || "No workload description yet."}
                </p>
                <label className="mt-3 block text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Status
                </label>
                <select
                  className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={selectedMapNode.status}
                  onChange={(event) => void updateSelectedMapNode((node) => ({
                    ...node,
                    status: event.currentTarget.value as ProjectMapNodeStatus,
                  }))}
                >
                  {PROJECT_MAP_STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>{status}</option>
                  ))}
                </select>
              </div>

              <div className="rounded-xl border border-border/60 p-3">
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Sessions</p>
                <div className="mt-2 space-y-2">
                  {selectedMapNode.sessionIds.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No sessions assigned yet.</p>
                  ) : selectedMapNode.sessionIds.map((sessionId) => (
                    <div key={sessionId} className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-2 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {sessionTitleById.get(sessionId)?.trim() || "Untitled Session"}
                        </p>
                        {selectedMapNode.primarySessionId === sessionId ? (
                          <p className="text-[11px] text-sky-700">Primary session</p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button type="button" size="sm" variant="outline" className="h-8 px-2" onClick={() => handleOpenSession(sessionId)}>
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Button>
                        <Button type="button" size="sm" variant="outline" className="h-8 px-2 text-rose-700" onClick={() => void handleDetachSession(sessionId)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>

                {selectedMapNode.sessionIds.length > 1 ? (
                  <>
                    <label className="mt-3 block text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Primary session</label>
                    <select
                      className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={selectedMapNode.primarySessionId ?? ""}
                      onChange={(event) => void updateSelectedMapNode((node) => ({
                        ...node,
                        primarySessionId: event.currentTarget.value || null,
                      }))}
                    >
                      {selectedMapNode.sessionIds.map((sessionId) => (
                        <option key={sessionId} value={sessionId}>
                          {sessionTitleById.get(sessionId)?.trim() || "Untitled Session"}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}

                <div className="mt-3 flex gap-2">
                  <select
                    aria-label="Session to attach"
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                    value={sessionToAttach}
                    onChange={(event) => setSessionToAttach(event.currentTarget.value)}
                  >
                    <option value="">Attach an existing session…</option>
                    {attachableSessions.map((session) => (
                      <option key={session.id} value={session.id}>
                        {session.title?.trim() || "Untitled Session"}
                      </option>
                    ))}
                  </select>
                  <Button type="button" size="sm" className="h-9" disabled={!sessionToAttach} onClick={() => void handleAttachSession()}>
                    Add
                  </Button>
                </div>
              </div>

              <div className="rounded-xl border border-border/60 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Published output</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      Downstream workloads receive this selected result, not the entire session transcript.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!selectedMapNode.primarySessionId}
                    onClick={() => void handlePublishOutput()}
                  >
                    Publish latest
                  </Button>
                </div>
                <p className="mt-2 max-h-28 overflow-hidden whitespace-pre-wrap rounded-lg bg-muted/40 p-2 text-xs leading-5 text-foreground/80">
                  {selectedMapNode.selectedOutput?.summary || "No output selected yet."}
                </p>
              </div>

              <div className="rounded-xl border border-border/60 p-3">
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Downstream</p>
                {outgoingDependencies.length > 0 ? (
                  <div className="mt-2 space-y-2">
                    {outgoingDependencies.map((edge) => (
                      <div key={edge.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">
                          → {effectiveMap.nodes.find((node) => node.id === edge.targetNodeId)?.title ?? edge.targetNodeId}
                        </span>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-rose-700" onClick={() => void handleRemoveDependency(edge.id)}>
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No downstream dependency yet.</p>
                )}
                <div className="mt-3 flex gap-2">
                  <select
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                    value={dependencyTargetId}
                    onChange={(event) => setDependencyTargetId(event.currentTarget.value)}
                  >
                    <option value="">Connect output to…</option>
                    {downstreamCandidates.map((node) => (
                      <option key={node.id} value={node.id}>{node.title}</option>
                    ))}
                  </select>
                  <Button type="button" size="sm" className="h-9" disabled={!dependencyTargetId} onClick={() => void handleAddDependency()}>
                    Connect
                  </Button>
                </div>
              </div>

              <Button type="button" variant="outline" className="w-full text-rose-700" onClick={() => void handleDeleteWorkload()}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete workload from map
              </Button>
            </div>
          )}
        </div>
      ) : null}

      <ReactFlow
        key={project.id}
        nodes={visibleNodes}
        edges={visibleEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ duration: 300, padding: 0.2 }}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onPaneClick={handlePaneClick}
        colorMode="light"
        className="h-full w-full bg-[radial-gradient(circle_at_top,rgba(125,211,252,0.12),transparent_34%),linear-gradient(180deg,rgba(248,250,252,1),rgba(241,245,249,0.92))]"
        defaultEdgeOptions={{ zIndex: 1 }}
        proOptions={{ hideAttribution: true }}
        minZoom={0.25}
        maxZoom={1.4}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnScroll
        panOnDrag
        zoomOnScroll
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.2}
          color="rgba(15,23,42,0.12)"
        />
        <MiniMap
          pannable
          zoomable
          nodeStrokeWidth={2}
          className="!h-32 !w-52 !rounded-2xl !border !border-border/70 !bg-background/90 !shadow-lg"
          nodeColor={(node) =>
            typeof node.data?.accent === "string" ? node.data.accent : "#94a3b8"
          }
        />
        <Controls className="!border !border-border/70 !bg-background/90 !shadow-sm" />
      </ReactFlow>
    </div>
  );
}

export function ProjectCanvas({
  project,
  sessions,
  memoryItems,
  onSelectionChange,
}: {
  project: ProjectDocument;
  sessions: SessionDocument[];
  memoryItems: ProjectMemoryItem[];
  onSelectionChange?: (selection: ProjectCanvasSelection) => void;
}) {
  return (
    <ReactFlowProvider>
      <ProjectCanvasInner
        project={project}
        sessions={sessions}
        memoryItems={memoryItems}
        onSelectionChange={onSelectionChange}
      />
    </ReactFlowProvider>
  );
}
