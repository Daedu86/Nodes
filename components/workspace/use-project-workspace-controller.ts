"use client";
import React from "react";
import { useSession } from "next-auth/react";
import { usePersistedSessions } from "@/components/context/persisted-sessions";
import { useProjects } from "@/components/context/projects";
import { useReusableMemory } from "@/components/context/reusable-memory";
import { estimateTokenCount } from "@/lib/context-budget";
import { normalizeMessages, toPlainTextTranscript } from "@/lib/llm/messages";
import type { ProjectMemorySourceKind, ProjectMemoryType } from "@/lib/memory-documents";
import type { ProjectCollaboratorRole } from "@/lib/project-documents";
import { PROJECT_MEMORY_TYPE_ORDER, formatProjectMemoryTypeLabel } from "@/lib/project-memory-meta";
import type { SessionDocument, SessionSummary } from "@/lib/session-documents";
import { type ProjectCanvasSelection } from "@/components/workspace/project-canvas";
import { formatMemoryTitle, formatSessionTitle, summarizePreviewText, summarizeSelectionForTypedNode } from "@/components/workspace/project-workspace-utils";
import { PROJECT_CANVAS_AUTOSTART_SESSION_THRESHOLD, type ArenaCompareMode, type ProjectInspectorTab, useResetProjectWorkspaceState } from "@/components/workspace/use-project-workspace-reset";
import { buildProjectArenaBranchEntries, type ProjectArenaBranchEntry, type ProjectArenaEntry, buildProjectArenaSessionEntry, buildProjectArenaSummary } from "@/lib/project-arena";
import { buildProjectContextDraft, buildProjectContextSources, getDefaultProjectContextSourceIds } from "@/lib/project-context-builder";
const encoder = new TextEncoder();
export function useProjectWorkspaceController() {
    const { activeProject, clearActiveProject, removeActiveProjectMember, saveActiveProjectMember, saveActiveProjectPatch, selectProject, } = useProjects();
    const { data: session } = useSession();
    const { activeSessionId, sessions: sessionSummaries } = usePersistedSessions();
    const { createMemoryItem, deleteMemoryItem, isReady: isMemoryReady, items: memoryItems } = useReusableMemory();
    const [selectedCanvasItem, setSelectedCanvasItem] = React.useState<ProjectCanvasSelection>(null);
    const globalContextEditorRef = React.useRef<HTMLTextAreaElement | null>(null);
    const [titleDraft, setTitleDraft] = React.useState(activeProject?.title ?? "");
    const [globalContextDraft, setGlobalContextDraft] = React.useState(activeProject?.globalContext ?? "");
    const [contextSaveState, setContextSaveState] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
    const [workspaceMode, setWorkspaceMode] = React.useState<"canvas" | "arena">(() => (activeProject?.sessionIds.length ?? 0) >= PROJECT_CANVAS_AUTOSTART_SESSION_THRESHOLD
        ? "arena"
        : "canvas");
    const [arenaCompareMode, setArenaCompareMode] = React.useState<ArenaCompareMode>("sessions");
    const [arenaSessionIds, setArenaSessionIds] = React.useState<string[]>([]);
    const [arenaBranchKeys, setArenaBranchKeys] = React.useState<string[]>([]);
    const [memoryTitleDraft, setMemoryTitleDraft] = React.useState("Arena synthesis");
    const [memoryTypeDraft, setMemoryTypeDraft] = React.useState<ProjectMemoryType>("summary");
    const [memoryContentDraft, setMemoryContentDraft] = React.useState("");
    const [memoryActionState, setMemoryActionState] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
    const [memoryActionMessage, setMemoryActionMessage] = React.useState("Create a typed node and attach it to this project.");
    const [selectedContextSourceIds, setSelectedContextSourceIds] = React.useState<string[]>([]);
    const [inspectorTab, setInspectorTab] = React.useState<ProjectInspectorTab>("context");
    const [memberEmailDraft, setMemberEmailDraft] = React.useState("");
    const [memberRoleDraft, setMemberRoleDraft] = React.useState<ProjectCollaboratorRole>("viewer");
    const [memberActionState, setMemberActionState] = React.useState<"idle" | "saving" | "saved" | "error">("idle");
    const [memberActionMessage, setMemberActionMessage] = React.useState("Share this project with editors or viewers.");
    const [isRefreshingCanvas, setIsRefreshingCanvas] = React.useState(false);
    const shouldPreferArenaOnLoad = React.useMemo(() => (activeProject?.sessionIds.length ?? 0) >= PROJECT_CANVAS_AUTOSTART_SESSION_THRESHOLD, [activeProject?.sessionIds.length]);
    useResetProjectWorkspaceState({
        activeProject,
        setArenaBranchKeys,
        setArenaCompareMode,
        setArenaSessionIds,
        setContextSaveState,
        setGlobalContextDraft,
        setInspectorTab,
        setMemberActionMessage,
        setMemberActionState,
        setMemberEmailDraft,
        setMemberRoleDraft,
        setMemoryActionMessage,
        setMemoryActionState,
        setMemoryContentDraft,
        setMemoryTitleDraft,
        setMemoryTypeDraft,
        setSelectedCanvasItem,
        setSelectedContextSourceIds,
        setTitleDraft,
        setWorkspaceMode,
    });
    const memberSessions = React.useMemo<SessionDocument[]>(() => activeProject?.sessions ?? [], [activeProject?.sessions]);
    const canEditProject = React.useMemo(() => activeProject?.accessRole === "owner" || activeProject?.accessRole === "editor", [activeProject?.accessRole]);
    const canManageProject = React.useMemo(() => activeProject?.accessRole === "owner", [activeProject?.accessRole]);
    const currentUserEmail = session?.user?.email?.trim().toLowerCase() ?? null;
    const focusGlobalContextEditor = React.useCallback(() => {
        if (typeof window === "undefined")
            return;
        window.setTimeout(() => {
            const editor = globalContextEditorRef.current;
            if (!editor)
                return;
            editor.scrollIntoView?.({
                behavior: "smooth",
                block: "center",
            });
            editor.focus();
            try {
                const cursorPosition = editor.value.length;
                editor.setSelectionRange(cursorPosition, cursorPosition);
            }
            catch {
                // Ignore selection sync failures in read-only or unsupported environments.
            }
        }, 0);
    }, []);
    React.useEffect(() => {
        if (!activeProject)
            return;
        if (!canEditProject)
            return;
        if (globalContextDraft === activeProject.globalContext)
            return;
        setContextSaveState("saving");
        const timeout = window.setTimeout(() => {
            void saveActiveProjectPatch({ globalContext: globalContextDraft })
                .then(() => setContextSaveState("saved"))
                .catch(() => setContextSaveState("error"));
        }, 500);
        return () => window.clearTimeout(timeout);
    }, [activeProject, canEditProject, globalContextDraft, saveActiveProjectPatch]);
    React.useEffect(() => {
        if (!selectedCanvasItem)
            return;
        if (selectedCanvasItem.kind === "node" && selectedCanvasItem.role === "global-context") {
            setInspectorTab("context");
            focusGlobalContextEditor();
            return;
        }
        setInspectorTab("focus");
    }, [focusGlobalContextEditor, selectedCanvasItem]);
    const handleCommitTitle = React.useCallback(async () => {
        if (!activeProject)
            return;
        if (!canEditProject)
            return;
        const normalizedTitle = titleDraft.trim() || null;
        if ((activeProject.title ?? null) === normalizedTitle)
            return;
        await saveActiveProjectPatch({ title: normalizedTitle });
    }, [activeProject, canEditProject, saveActiveProjectPatch, titleDraft]);
    const handleOpenSession = React.useCallback((sessionId: string) => {
        clearActiveProject();
        if (typeof window === "undefined") {
            return;
        }
        window.location.assign(`/?sessionId=${encodeURIComponent(sessionId)}`);
    }, [clearActiveProject]);
    const handleExitProject = React.useCallback(() => {
        clearActiveProject();
        const targetSessionId = activeSessionId ?? activeProject?.sessionIds[0] ?? null;
        if (!targetSessionId || typeof window === "undefined") {
            return;
        }
        window.location.assign(`/?sessionId=${encodeURIComponent(targetSessionId)}`);
    }, [activeProject?.sessionIds, activeSessionId, clearActiveProject]);
    const handleRefreshCanvas = React.useCallback(async () => {
        if (!activeProject || isRefreshingCanvas)
            return;
        setIsRefreshingCanvas(true);
        try {
            await selectProject(activeProject.id);
        }
        finally {
            setIsRefreshingCanvas(false);
        }
    }, [activeProject, isRefreshingCanvas, selectProject]);
    const handleAddSession = React.useCallback(async (sessionId: string) => {
        if (!activeProject)
            return;
        if (!canManageProject)
            return;
        if (activeProject.sessionIds.includes(sessionId))
            return;
        await saveActiveProjectPatch({
            sessionIds: [...activeProject.sessionIds, sessionId],
        });
    }, [activeProject, canManageProject, saveActiveProjectPatch]);
    const handleRemoveSession = React.useCallback(async (sessionId: string) => {
        if (!activeProject)
            return;
        if (!canManageProject)
            return;
        const branchWinnerBelongsToRemovedSession = typeof activeProject.arenaWinnerBranchKey === "string" &&
            activeProject.arenaWinnerBranchKey.startsWith(`${sessionId}:`);
        await saveActiveProjectPatch({
            arenaWinnerBranchKey: branchWinnerBelongsToRemovedSession ? null : activeProject.arenaWinnerBranchKey,
            arenaWinnerSessionId: activeProject.arenaWinnerSessionId === sessionId ? null : activeProject.arenaWinnerSessionId,
            sessionIds: activeProject.sessionIds.filter((entry) => entry !== sessionId),
        });
    }, [activeProject, canManageProject, saveActiveProjectPatch]);
    const availableSessions = React.useMemo(() => {
        if (!activeProject || !canManageProject)
            return [] satisfies SessionSummary[];
        const included = new Set(activeProject.sessionIds);
        return sessionSummaries.filter((session) => !included.has(session.id));
    }, [activeProject, canManageProject, sessionSummaries]);
    const attachedMemoryItems = React.useMemo(() => {
        if (!activeProject)
            return [];
        const attached = new Set(activeProject.memoryIds);
        const byId = new Map((activeProject.attachedMemoryItems ?? [])
            .filter((item) => attached.has(item.id))
            .map((item) => [item.id, item] as const));
        memoryItems.forEach((item) => {
            if (attached.has(item.id))
                byId.set(item.id, item);
        });
        return [...byId.values()];
    }, [activeProject, memoryItems]);
    const availableMemoryItems = React.useMemo(() => {
        if (!activeProject || !canManageProject)
            return [];
        const attached = new Set(activeProject.memoryIds);
        return memoryItems.filter((item) => !attached.has(item.id));
    }, [activeProject, canManageProject, memoryItems]);
    const attachedMemoryGroups = React.useMemo(() => PROJECT_MEMORY_TYPE_ORDER.map((type) => ({
        items: attachedMemoryItems.filter((item) => item.type === type),
        type,
    })).filter((group) => group.items.length > 0), [attachedMemoryItems]);
    const availableMemoryGroups = React.useMemo(() => PROJECT_MEMORY_TYPE_ORDER.map((type) => ({
        items: availableMemoryItems.filter((item) => item.type === type),
        type,
    })).filter((group) => group.items.length > 0), [availableMemoryItems]);
    const arenaBranchCatalog = React.useMemo(() => memberSessions.flatMap((session) => buildProjectArenaBranchEntries(session)), [memberSessions]);
    React.useEffect(() => {
        const availableIds = memberSessions.map((session) => session.id);
        setArenaSessionIds((prev) => {
            const filtered = prev.filter((sessionId) => availableIds.includes(sessionId));
            if (filtered.length >= 2 || memberSessions.length < 2) {
                return filtered;
            }
            return availableIds.slice(0, Math.min(2, availableIds.length));
        });
    }, [memberSessions]);
    React.useEffect(() => {
        const availableKeys = arenaBranchCatalog.map((entry) => entry.key);
        setArenaBranchKeys((prev) => {
            const filtered = prev.filter((key) => availableKeys.includes(key));
            if (filtered.length >= 2 || arenaBranchCatalog.length < 2) {
                return filtered;
            }
            return availableKeys.slice(0, Math.min(2, availableKeys.length));
        });
    }, [arenaBranchCatalog]);
    const toggleArenaSession = React.useCallback((sessionId: string) => {
        setArenaSessionIds((prev) => {
            if (prev.includes(sessionId)) {
                return prev.filter((entry) => entry !== sessionId);
            }
            if (prev.length >= 4) {
                return prev;
            }
            return [...prev, sessionId];
        });
    }, []);
    const toggleArenaBranch = React.useCallback((branchKey: string) => {
        setArenaBranchKeys((prev) => {
            if (prev.includes(branchKey)) {
                return prev.filter((entry) => entry !== branchKey);
            }
            if (prev.length >= 4) {
                return prev;
            }
            return [...prev, branchKey];
        });
    }, []);
    const aggregateStats = React.useMemo(() => {
        const transcriptBlocks = memberSessions.map((session) => {
            const normalizedMessages = normalizeMessages(session.snapshot.messages.map((entry) => entry.message));
            const transcript = toPlainTextTranscript(normalizedMessages);
            return `[${formatSessionTitle(session.title)}]\n${transcript}`.trim();
        });
        const aggregateText = [
            activeProject?.title?.trim() ? `Project: ${activeProject.title.trim()}` : "",
            globalContextDraft.trim() ? `Global context:\n${globalContextDraft.trim()}` : "",
            ...transcriptBlocks,
        ]
            .filter((value) => value.length > 0)
            .join("\n\n");
        const bytes = encoder.encode(aggregateText).length;
        const messageCount = memberSessions.reduce((total, session) => total + session.snapshot.messages.length, 0);
        const artifactCount = memberSessions.reduce((total, session) => total + session.artifacts.length, 0);
        return {
            artifactCount,
            bytes,
            estimatedTokens: estimateTokenCount(aggregateText),
            messageCount,
            text: aggregateText,
        };
    }, [activeProject?.title, globalContextDraft, memberSessions]);
    const globalContextPreview = React.useMemo(() => {
        const preview = summarizePreviewText(globalContextDraft, 240);
        return preview.length > 0
            ? preview
            : "No shared project guidance yet. Add reusable goals, constraints, or synthesis notes for every attached session.";
    }, [globalContextDraft]);
    const projectView = React.useMemo(() => {
        if (!activeProject)
            return null;
        return {
            ...activeProject,
            globalContext: globalContextDraft,
            title: titleDraft.trim() || null,
        };
    }, [activeProject, globalContextDraft, titleDraft]);
    const arenaSessionEntries = React.useMemo(() => memberSessions
        .filter((session) => arenaSessionIds.includes(session.id))
        .map((session) => buildProjectArenaSessionEntry(session)), [arenaSessionIds, memberSessions]);
    const arenaBranchEntries = React.useMemo(() => arenaBranchCatalog.filter((entry) => arenaBranchKeys.includes(entry.key)), [arenaBranchCatalog, arenaBranchKeys]);
    const arenaEntries = React.useMemo<ProjectArenaEntry[]>(() => (arenaCompareMode === "sessions" ? arenaSessionEntries : arenaBranchEntries), [arenaBranchEntries, arenaCompareMode, arenaSessionEntries]);
    const arenaSummary = React.useMemo(() => buildProjectArenaSummary(arenaEntries, globalContextDraft, attachedMemoryItems), [arenaEntries, attachedMemoryItems, globalContextDraft]);
    const selectedMemoryItem = React.useMemo(() => {
        if (!selectedCanvasItem || selectedCanvasItem.kind !== "node" || !selectedCanvasItem.memoryId) {
            return null;
        }
        return attachedMemoryItems.find((item) => item.id === selectedCanvasItem.memoryId) ?? null;
    }, [attachedMemoryItems, selectedCanvasItem]);
    const selectedMergeMemory = React.useMemo(() => {
        if (!selectedCanvasItem || selectedCanvasItem.kind !== "node")
            return null;
        if (selectedCanvasItem.memoryType !== "merge" || !selectedCanvasItem.memoryId)
            return null;
        return selectedMemoryItem?.type === "merge" ? selectedMemoryItem : null;
    }, [selectedCanvasItem, selectedMemoryItem]);
    const projectContextSources = React.useMemo(() => activeProject
        ? buildProjectContextSources({
            arenaSummary,
            attachedMemoryItems,
            branchCatalog: arenaBranchCatalog,
            project: activeProject,
            selectedFocus: selectedCanvasItem,
            sessions: memberSessions,
        })
        : [], [activeProject, arenaBranchCatalog, arenaSummary, attachedMemoryItems, memberSessions, selectedCanvasItem]);
    const selectedProjectContextSources = React.useMemo(() => projectContextSources.filter((source) => selectedContextSourceIds.includes(source.id)), [projectContextSources, selectedContextSourceIds]);
    const projectContextBuilderDraft = React.useMemo(() => buildProjectContextDraft(selectedProjectContextSources), [selectedProjectContextSources]);
    const selectedArenaCount = arenaCompareMode === "sessions" ? arenaSessionIds.length : arenaBranchKeys.length;
    const inspectorTabMeta: Record<ProjectInspectorTab, {
        badge: string;
        description: string;
        label: string;
    }> = {
        context: {
            badge: String(selectedProjectContextSources.length),
            description: "Shape the project-wide guidance and compose a cleaner global context from reusable sources.",
            label: "Context",
        },
        arena: {
            badge: `${selectedArenaCount}/4`,
            description: "Pick the sessions or branches that matter, then drive Arena comparisons from one place.",
            label: "Arena",
        },
        nodes: {
            badge: String(attachedMemoryItems.length),
            description: "Create and attach typed nodes that turn conclusions into reusable project structure.",
            label: "Nodes",
        },
        sessions: {
            badge: String(memberSessions.length),
            description: "Curate which saved sessions belong to the project and keep the canvas source set clean.",
            label: "Sessions",
        },
        focus: {
            badge: selectedCanvasItem ? "1" : "0",
            description: "Inspect the last selected canvas node or branch and turn it into context or a typed node.",
            label: "Focus",
        },
    };
    React.useEffect(() => {
        if (!arenaSummary)
            return;
        const leadEntry = arenaEntries.find((entry) => entry.key === arenaSummary.leadKey);
        if (!leadEntry)
            return;
        setMemoryTitleDraft((current) => current === "Arena synthesis" || current.trim().length === 0
            ? `${leadEntry.title} synthesis`
            : current);
    }, [arenaEntries, arenaSummary]);
    const handleAppendArenaSummary = React.useCallback(() => {
        if (!arenaSummary)
            return;
        if (!canEditProject)
            return;
        setGlobalContextDraft((prev) => {
            const trimmed = prev.trim();
            return trimmed.length > 0 ? `${trimmed}\n\n${arenaSummary.note}` : arenaSummary.note;
        });
        setWorkspaceMode("canvas");
    }, [arenaSummary, canEditProject]);
    const handlePromoteArenaWinner = React.useCallback(async () => {
        if (!arenaSummary)
            return;
        if (!canEditProject)
            return;
        if (arenaSummary.kind === "branch") {
            const leadEntry = arenaEntries.find((entry): entry is ProjectArenaBranchEntry => entry.key === arenaSummary.leadKey && entry.kind === "branch");
            if (!leadEntry)
                return;
            await saveActiveProjectPatch({
                arenaWinnerBranchKey: leadEntry.key,
                arenaWinnerSessionId: leadEntry.sessionId,
            });
            return;
        }
        const leadEntry = arenaEntries.find((entry) => entry.key === arenaSummary.leadKey);
        if (!leadEntry)
            return;
        await saveActiveProjectPatch({
            arenaWinnerBranchKey: null,
            arenaWinnerSessionId: leadEntry.sessionId,
        });
    }, [arenaEntries, arenaSummary, canEditProject, saveActiveProjectPatch]);
    const handleSaveArenaSummaryAsMemory = React.useCallback(async () => {
        if (!activeProject || !arenaSummary)
            return;
        if (!canManageProject)
            return;
        const leadEntry = arenaEntries.find((entry) => entry.key === arenaSummary.leadKey);
        if (!leadEntry)
            return;
        setMemoryActionState("saving");
        setMemoryActionMessage("Saving arena synthesis as a typed node...");
        try {
            const item = await createMemoryItem({
                content: arenaSummary.note,
                sourceProjectId: activeProject.id,
                sourceKeys: arenaEntries.map((entry) => entry.key),
                sourceKind: arenaSummary.kind,
                sourceSessionId: leadEntry.sessionId,
                title: formatMemoryTitle(memoryTitleDraft),
                type: memoryTypeDraft,
            });
            await saveActiveProjectPatch({
                memoryIds: [...new Set([...activeProject.memoryIds, item.id])],
            });
            setMemoryActionState("saved");
            setMemoryContentDraft(arenaSummary.note);
            setMemoryActionMessage("Typed node saved from Arena synthesis.");
        }
        catch {
            setMemoryActionState("error");
            setMemoryActionMessage("Could not save the Arena synthesis as a typed node.");
        }
    }, [
        activeProject,
        arenaSummary,
        createMemoryItem,
        arenaEntries,
        canManageProject,
        memoryTitleDraft,
        memoryTypeDraft,
        saveActiveProjectPatch,
    ]);
    const handleCreateArenaMergeNode = React.useCallback(async () => {
        if (!activeProject || !arenaSummary)
            return;
        if (!canManageProject)
            return;
        const leadEntry = arenaEntries.find((entry) => entry.key === arenaSummary.leadKey);
        if (!leadEntry)
            return;
        setMemoryActionState("saving");
        setMemoryActionMessage("Creating merge node from Arena synthesis...");
        try {
            const mergeTitle = `${leadEntry.title} merge node`;
            const item = await createMemoryItem({
                content: arenaSummary.note,
                sourceProjectId: activeProject.id,
                sourceKeys: arenaEntries.map((entry) => entry.key),
                sourceKind: arenaSummary.kind,
                sourceSessionId: leadEntry.sessionId,
                title: mergeTitle,
                type: "merge",
            });
            await saveActiveProjectPatch({
                memoryIds: [...new Set([...activeProject.memoryIds, item.id])],
            });
            setMemoryTitleDraft(mergeTitle);
            setMemoryActionState("saved");
            setMemoryActionMessage("Merge node created and attached to the project.");
            setWorkspaceMode("canvas");
        }
        catch {
            setMemoryActionState("error");
            setMemoryActionMessage("Could not create the merge node.");
        }
    }, [activeProject, arenaEntries, arenaSummary, canManageProject, createMemoryItem, saveActiveProjectPatch]);
    const handleSeedTypedNodeFromArena = React.useCallback(() => {
        if (!arenaSummary)
            return;
        const leadEntry = arenaEntries.find((entry) => entry.key === arenaSummary.leadKey);
        setMemoryContentDraft(arenaSummary.note);
        setMemoryTitleDraft((current) => {
            const trimmed = current.trim();
            if (trimmed.length > 0 && trimmed !== "Arena synthesis")
                return current;
            return leadEntry ? `${leadEntry.title} ${formatProjectMemoryTypeLabel(memoryTypeDraft).toLowerCase()}` : current;
        });
        setMemoryActionState("idle");
        setMemoryActionMessage("Arena synthesis copied into the typed node composer.");
        setInspectorTab("nodes");
    }, [arenaEntries, arenaSummary, memoryTypeDraft]);
    const handleSeedTypedNodeFromCanvasFocus = React.useCallback(() => {
        if (!selectedCanvasItem)
            return;
        if (!canManageProject)
            return;
        const summary = summarizeSelectionForTypedNode(selectedCanvasItem);
        if (!summary)
            return;
        setMemoryContentDraft(summary);
        setMemoryTitleDraft((current) => {
            const trimmed = current.trim();
            if (trimmed.length > 0 && trimmed !== "Arena synthesis")
                return current;
            return `${selectedCanvasItem.label} ${formatProjectMemoryTypeLabel(memoryTypeDraft).toLowerCase()}`;
        });
        setMemoryActionState("idle");
        setMemoryActionMessage("Canvas focus copied into the typed node composer.");
        setInspectorTab("nodes");
    }, [canManageProject, memoryTypeDraft, selectedCanvasItem]);
    const handleCreateTypedNode = React.useCallback(async () => {
        if (!activeProject)
            return;
        if (!canManageProject)
            return;
        const title = formatMemoryTitle(memoryTitleDraft);
        const content = memoryContentDraft.trim();
        if (!title || !content) {
            setMemoryActionState("error");
            setMemoryActionMessage("Typed nodes need both a title and content.");
            return;
        }
        let sourceKind: ProjectMemorySourceKind = null;
        let sourceKeys: string[] = [];
        let sourceSessionId: string | null = null;
        if (selectedCanvasItem?.kind === "node" && selectedCanvasItem.sessionId) {
            sourceSessionId = selectedCanvasItem.sessionId;
            if (selectedCanvasItem.role === "session") {
                sourceKind = "session";
                sourceKeys = [selectedCanvasItem.sessionId];
            }
            else if (selectedCanvasItem.messageId) {
                sourceKind = "branch";
                sourceKeys = [`${selectedCanvasItem.sessionId}:${selectedCanvasItem.messageId}`];
            }
        }
        setMemoryActionState("saving");
        setMemoryActionMessage("Creating typed node...");
        try {
            const item = await createMemoryItem({
                content,
                sourceProjectId: activeProject.id,
                sourceKeys,
                sourceKind,
                sourceSessionId,
                title,
                type: memoryTypeDraft,
            });
            await saveActiveProjectPatch({
                memoryIds: [...new Set([...activeProject.memoryIds, item.id])],
            });
            setMemoryActionState("saved");
            setMemoryActionMessage(`${formatProjectMemoryTypeLabel(memoryTypeDraft)} node created and attached.`);
            setMemoryTitleDraft(`${formatProjectMemoryTypeLabel(memoryTypeDraft)} note`);
            setMemoryContentDraft("");
            setWorkspaceMode("canvas");
        }
        catch {
            setMemoryActionState("error");
            setMemoryActionMessage("Could not create the typed node.");
        }
    }, [
        activeProject,
        createMemoryItem,
        canManageProject,
        memoryContentDraft,
        memoryTitleDraft,
        memoryTypeDraft,
        saveActiveProjectPatch,
        selectedCanvasItem,
    ]);
    const handleAttachMemory = React.useCallback(async (memoryId: string) => {
        if (!activeProject)
            return;
        if (!canManageProject)
            return;
        await saveActiveProjectPatch({
            memoryIds: [...new Set([...activeProject.memoryIds, memoryId])],
        });
    }, [activeProject, canManageProject, saveActiveProjectPatch]);
    const handleDetachMemory = React.useCallback(async (memoryId: string) => {
        if (!activeProject)
            return;
        if (!canManageProject)
            return;
        await saveActiveProjectPatch({
            memoryIds: activeProject.memoryIds.filter((entry) => entry !== memoryId),
        });
    }, [activeProject, canManageProject, saveActiveProjectPatch]);
    const handleDeleteMemory = React.useCallback(async (memoryId: string) => {
        if (!activeProject)
            return;
        if (!canManageProject)
            return;
        await deleteMemoryItem(memoryId);
        await saveActiveProjectPatch({
            memoryIds: activeProject.memoryIds.filter((entry) => entry !== memoryId),
        });
    }, [activeProject, canManageProject, deleteMemoryItem, saveActiveProjectPatch]);
    const handleReplaceGlobalContextWithMerge = React.useCallback(() => {
        if (!canEditProject)
            return;
        const mergeContent = selectedMergeMemory?.content.trim() ?? selectedCanvasItem?.preview.trim() ?? "";
        if (!mergeContent)
            return;
        setGlobalContextDraft(mergeContent);
        setInspectorTab("context");
    }, [canEditProject, selectedCanvasItem?.preview, selectedMergeMemory]);
    const handleAppendMergeToGlobalContext = React.useCallback(() => {
        if (!canEditProject)
            return;
        const mergeContent = selectedMergeMemory?.content.trim() ?? selectedCanvasItem?.preview.trim() ?? "";
        if (!mergeContent)
            return;
        setGlobalContextDraft((prev) => {
            const trimmed = prev.trim();
            if (trimmed.length === 0)
                return mergeContent;
            if (trimmed.includes(mergeContent))
                return trimmed;
            return `${trimmed}\n\n${mergeContent}`;
        });
        setInspectorTab("context");
    }, [canEditProject, selectedCanvasItem?.preview, selectedMergeMemory]);
    const handleAppendSelectedMemoryToGlobalContext = React.useCallback(() => {
        if (!canEditProject)
            return;
        const content = selectedMemoryItem?.content.trim() ?? "";
        if (!content)
            return;
        setGlobalContextDraft((prev) => {
            const trimmed = prev.trim();
            if (trimmed.length === 0)
                return content;
            if (trimmed.includes(content))
                return trimmed;
            return `${trimmed}\n\n${content}`;
        });
        setInspectorTab("context");
    }, [canEditProject, selectedMemoryItem]);
    const toggleProjectContextSource = React.useCallback((sourceId: string) => {
        setSelectedContextSourceIds((prev) => prev.includes(sourceId)
            ? prev.filter((entry) => entry !== sourceId)
            : [...prev, sourceId]);
    }, []);
    const handleSelectDefaultContextSources = React.useCallback(() => {
        setSelectedContextSourceIds(getDefaultProjectContextSourceIds(projectContextSources));
    }, [projectContextSources]);
    const handleSelectAllContextSources = React.useCallback(() => {
        setSelectedContextSourceIds(projectContextSources.map((source) => source.id));
    }, [projectContextSources]);
    const handleClearContextSources = React.useCallback(() => {
        setSelectedContextSourceIds([]);
    }, []);
    const handleReplaceGlobalContextWithBuilder = React.useCallback(() => {
        if (!canEditProject)
            return;
        const nextText = projectContextBuilderDraft.text.trim();
        if (!nextText)
            return;
        setGlobalContextDraft(nextText);
        setInspectorTab("context");
    }, [canEditProject, projectContextBuilderDraft.text]);
    const handleAppendBuilderToGlobalContext = React.useCallback(() => {
        if (!canEditProject)
            return;
        const nextText = projectContextBuilderDraft.text.trim();
        if (!nextText)
            return;
        setGlobalContextDraft((prev) => {
            const trimmed = prev.trim();
            if (trimmed.length === 0)
                return nextText;
            if (trimmed.includes(nextText))
                return trimmed;
            return `${trimmed}\n\n${nextText}`;
        });
        setInspectorTab("context");
    }, [canEditProject, projectContextBuilderDraft.text]);
    const handleEditGlobalContext = React.useCallback(() => {
        setInspectorTab("context");
        focusGlobalContextEditor();
    }, [focusGlobalContextEditor]);
    const handleSaveProjectMember = React.useCallback(async () => {
        if (!activeProject || !canManageProject)
            return;
        const email = memberEmailDraft.trim().toLowerCase();
        if (!email) {
            setMemberActionState("error");
            setMemberActionMessage("Enter an email before sharing the project.");
            return;
        }
        if (currentUserEmail && email === currentUserEmail) {
            setMemberActionState("error");
            setMemberActionMessage("You already own this project.");
            return;
        }
        setMemberActionState("saving");
        setMemberActionMessage(`Adding ${email} as ${memberRoleDraft}...`);
        try {
            await saveActiveProjectMember({ email, role: memberRoleDraft });
            setMemberEmailDraft("");
            setMemberActionState("saved");
            setMemberActionMessage(`Project shared with ${email}.`);
        }
        catch {
            setMemberActionState("error");
            setMemberActionMessage("Could not update project members.");
        }
    }, [
        activeProject,
        canManageProject,
        currentUserEmail,
        memberEmailDraft,
        memberRoleDraft,
        saveActiveProjectMember,
    ]);
    const handleRemoveProjectMember = React.useCallback(async (email: string) => {
        if (!canManageProject)
            return;
        setMemberActionState("saving");
        setMemberActionMessage(`Removing ${email}...`);
        try {
            await removeActiveProjectMember(email);
            setMemberActionState("saved");
            setMemberActionMessage(`${email} removed from the project.`);
        }
        catch {
            setMemberActionState("error");
            setMemberActionMessage("Could not remove that project member.");
        }
    }, [canManageProject, removeActiveProjectMember]);
    const handleChangeProjectMemberRole = React.useCallback(async (email: string, role: ProjectCollaboratorRole) => {
        if (!canManageProject)
            return;
        setMemberActionState("saving");
        setMemberActionMessage(`Updating ${email} to ${role}...`);
        try {
            await saveActiveProjectMember({ email, role });
            setMemberActionState("saved");
            setMemberActionMessage(`${email} is now ${role}.`);
        }
        catch {
            setMemberActionState("error");
            setMemberActionMessage("Could not update that project member.");
        }
    }, [canManageProject, saveActiveProjectMember]);
    if (!activeProject || !projectView) {
        return null;
    }
    return {
        activeProject,
        isMemoryReady,
        selectedCanvasItem,
        setSelectedCanvasItem,
        globalContextEditorRef,
        titleDraft,
        setTitleDraft,
        globalContextDraft,
        setGlobalContextDraft,
        contextSaveState,
        workspaceMode,
        setWorkspaceMode,
        arenaCompareMode,
        setArenaCompareMode,
        arenaSessionIds,
        arenaBranchKeys,
        memoryTitleDraft,
        setMemoryTitleDraft,
        memoryTypeDraft,
        setMemoryTypeDraft,
        memoryContentDraft,
        setMemoryContentDraft,
        memoryActionState,
        memoryActionMessage,
        selectedContextSourceIds,
        inspectorTab,
        setInspectorTab,
        memberEmailDraft,
        setMemberEmailDraft,
        memberRoleDraft,
        setMemberRoleDraft,
        memberActionState,
        memberActionMessage,
        shouldPreferArenaOnLoad,
        memberSessions,
        canEditProject,
        canManageProject,
        handleCommitTitle,
        handleOpenSession,
        handleExitProject,
        handleRefreshCanvas,
        isRefreshingCanvas,
        handleAddSession,
        handleRemoveSession,
        availableSessions,
        attachedMemoryItems,
        availableMemoryItems,
        attachedMemoryGroups,
        availableMemoryGroups,
        arenaBranchCatalog,
        toggleArenaSession,
        toggleArenaBranch,
        aggregateStats,
        globalContextPreview,
        projectView,
        arenaEntries,
        arenaSummary,
        selectedMemoryItem,
        selectedMergeMemory,
        projectContextSources,
        selectedProjectContextSources,
        projectContextBuilderDraft,
        selectedArenaCount,
        inspectorTabMeta,
        handleAppendArenaSummary,
        handlePromoteArenaWinner,
        handleSaveArenaSummaryAsMemory,
        handleCreateArenaMergeNode,
        handleSeedTypedNodeFromArena,
        handleSeedTypedNodeFromCanvasFocus,
        handleCreateTypedNode,
        handleAttachMemory,
        handleDetachMemory,
        handleDeleteMemory,
        handleReplaceGlobalContextWithMerge,
        handleAppendMergeToGlobalContext,
        handleAppendSelectedMemoryToGlobalContext,
        toggleProjectContextSource,
        handleSelectDefaultContextSources,
        handleSelectAllContextSources,
        handleClearContextSources,
        handleReplaceGlobalContextWithBuilder,
        handleAppendBuilderToGlobalContext,
        handleEditGlobalContext,
        handleSaveProjectMember,
        handleRemoveProjectMember,
        handleChangeProjectMemberRole,
    };
}
