"use client";

import React from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clipboard,
  Loader2,
  PanelRightOpen,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  TerminalSquare,
} from "lucide-react";
import { useCodexAgentRuns } from "@/components/assistant-ui/thread-graph-flow/use-codex-agent-runs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import type { ProjectCanvasSelection } from "@/components/workspace/project-canvas";
import type { ProjectDocument } from "@/lib/project-documents";
import {
  buildProjectMapInputSummary,
  getProjectMapNode,
  normalizeProjectMap,
} from "@/lib/project-map";

type RunnerNextStep = {
  code: "ready" | "configure_runner" | "start_runner" | "authenticate" | "configure_workspace";
  title: string;
  detail: string;
  command?: string;
};

type RunnerStatus = {
  configured: boolean;
  reachable: boolean;
  ok: boolean;
  codexRunning: boolean;
  authenticated: boolean;
  model: string | null;
  workspaceCount: number;
  hasDefaultWorkspace: boolean;
  nextStep: RunnerNextStep;
};

type ManagedAgentData = {
  kind?: string;
  title?: string;
  agentRunId?: string | null;
  agentStatus?: string;
  agentPrompt?: string;
  agentOutput?: string;
  agentError?: string | null;
  agentPendingApprovalId?: string | null;
  onAgentPromptChange?: (value: string) => void;
  onAgentRoleChange?: (value: "coder") => void;
  onAgentStart?: () => void;
  onAgentCancel?: () => void;
  onAgentApproval?: (decision: "accept" | "acceptForSession" | "decline" | "cancel") => void;
};

type PendingLaunch = {
  existingIds: Set<string>;
  label: string;
  prompt: string;
  stage: "await-node" | "await-prompt";
  localId?: string;
};

const statusPill = (ok: boolean, yes: string, no: string) => (
  <span
    className={[
      "rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]",
      ok
        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700"
        : "border-amber-500/25 bg-amber-500/10 text-amber-700",
    ].join(" ")}
  >
    {ok ? yes : no}
  </span>
);

export function ProjectExecutionRunnerPanel({
  project,
  selection,
}: {
  project: ProjectDocument;
  selection: ProjectCanvasSelection;
}) {
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState<RunnerStatus | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = React.useState("");
  const [pendingLaunch, setPendingLaunch] = React.useState<PendingLaunch | null>(null);
  const [managedLocalId, setManagedLocalId] = React.useState<string | null>(null);

  const projectMap = React.useMemo(() => normalizeProjectMap(project.map), [project.map]);
  const selectedNode = React.useMemo(() => {
    if (!selection || selection.kind !== "node" || !selection.mapNodeId) return null;
    return getProjectMapNode(projectMap, selection.mapNodeId);
  }, [projectMap, selection]);

  const selectedSessionId =
    selectedNode?.primarySessionId ??
    (selection?.kind === "node" ? selection.sessionId : null) ??
    null;

  const upstreamSummary = React.useMemo(
    () => (selectedNode ? buildProjectMapInputSummary(projectMap, selectedNode.id) : ""),
    [projectMap, selectedNode],
  );

  const managedRuns = useCodexAgentRuns({
    sessionId: selectedSessionId,
    projectId: project.id,
  });

  const agentRunNodes = React.useMemo(
    () => managedRuns.agentNodes.filter((node) => (node.data as ManagedAgentData).kind === "agent-run"),
    [managedRuns.agentNodes],
  );
  const managedNode = React.useMemo(
    () => agentRunNodes.find((node) => node.id === managedLocalId) ?? null,
    [agentRunNodes, managedLocalId],
  );
  const managedData = (managedNode?.data as ManagedAgentData | undefined) ?? null;
  const runBusy = Boolean(
    pendingLaunch ||
      (managedData?.agentStatus && !["completed", "failed", "cancelled"].includes(managedData.agentStatus)),
  );

  React.useEffect(() => {
    setManagedLocalId(null);
    setPendingLaunch(null);
    setMessage(null);
  }, [selectedSessionId]);

  React.useEffect(() => {
    if (!pendingLaunch) return;
    if (pendingLaunch.stage === "await-node") {
      const created = agentRunNodes.find((node) => !pendingLaunch.existingIds.has(node.id));
      if (!created) return;
      const data = created.data as ManagedAgentData;
      data.onAgentPromptChange?.(pendingLaunch.prompt);
      data.onAgentRoleChange?.("coder");
      setManagedLocalId(created.id);
      setPendingLaunch((current) =>
        current
          ? { ...current, localId: created.id, stage: "await-prompt" }
          : null,
      );
      return;
    }

    const node = pendingLaunch.localId
      ? agentRunNodes.find((entry) => entry.id === pendingLaunch.localId)
      : null;
    const data = node?.data as ManagedAgentData | undefined;
    if (!node || !data || data.agentPrompt !== pendingLaunch.prompt) return;
    data.onAgentStart?.();
    setPendingLaunch(null);
    setMessage("Managed Codex run started. Output, approvals, cancellation, and reconnect state are attached to this session.");
  }, [agentRunNodes, pendingLaunch]);

  React.useEffect(() => {
    try {
      setWorkspaceId(window.localStorage.getItem(`nodes:runner-workspace:${project.id}`) ?? "");
    } catch {
      setWorkspaceId("");
    }
  }, [project.id]);

  React.useEffect(() => {
    try {
      if (workspaceId) {
        window.localStorage.setItem(`nodes:runner-workspace:${project.id}`, workspaceId);
      } else {
        window.localStorage.removeItem(`nodes:runner-workspace:${project.id}`);
      }
    } catch {
      // Local storage is a convenience only; runner configuration remains authoritative.
    }
  }, [project.id, workspaceId]);

  const refreshStatus = React.useCallback(async () => {
    setChecking(true);
    setMessage(null);
    try {
      const response = await fetch("/api/agents/codex/status", {
        method: "GET",
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as RunnerStatus | null;
      if (!response.ok || !body) throw new Error(`Runner status failed: ${response.status}`);
      setStatus(body);
    } catch (error) {
      setStatus(null);
      setMessage(error instanceof Error ? error.message : "Unable to check runner status.");
    } finally {
      setChecking(false);
    }
  }, []);

  React.useEffect(() => {
    if (!open) return;
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 30_000);
    return () => window.clearInterval(timer);
  }, [open, refreshStatus]);

  const workspaceReady = Boolean(
    status && (status.hasDefaultWorkspace || status.workspaceCount > 0),
  );
  const needsExplicitWorkspace = Boolean(
    status && !status.hasDefaultWorkspace && status.workspaceCount > 0,
  );
  const canRun = Boolean(
    project.accessRole === "owner" &&
      status?.reachable &&
      status.codexRunning &&
      status.authenticated &&
      workspaceReady &&
      selectedNode &&
      selectedSessionId &&
      (!needsExplicitWorkspace || workspaceId.trim()),
  );

  const runSelectedWorkload = React.useCallback(() => {
    if (!selectedNode || !selectedSessionId || !canRun || runBusy) return;
    setMessage(null);
    const prompt = [
      "Execute this Nodes project workload in the configured workspace.",
      `Project: ${project.title ?? project.id}`,
      `Workload: ${selectedNode.title}`,
      selectedNode.description ? `Objective: ${selectedNode.description}` : "",
      upstreamSummary ? `Selected upstream outputs:\n${upstreamSummary}` : "",
      workspaceId.trim() ? `Requested runner workspace id: ${workspaceId.trim()}` : "",
      "Use the repository/workspace as the source of truth. Preserve useful outputs as files/artifacts and report what was executed, verified, and what remains blocked. Do not expose local credentials or authentication files.",
    ]
      .filter(Boolean)
      .join("\n\n");

    setPendingLaunch({
      existingIds: new Set(agentRunNodes.map((node) => node.id)),
      label: selectedNode.title,
      prompt,
      stage: "await-node",
    });
    managedRuns.addAgent();
  }, [
    agentRunNodes,
    canRun,
    managedRuns,
    project.id,
    project.title,
    runBusy,
    selectedNode,
    selectedSessionId,
    upstreamSummary,
    workspaceId,
  ]);

  const copyCommand = React.useCallback(async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setMessage(`Copied: ${command}`);
    } catch {
      setMessage(`Run this on the runner machine: ${command}`);
    }
  }, []);

  if (project.accessRole !== "owner") return null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="absolute right-4 top-4 z-30 gap-2 bg-background/95 shadow-sm backdrop-blur"
          aria-label="Open execution runner"
        >
          <PanelRightOpen className="h-4 w-4" />
          Runner
        </Button>
      </SheetTrigger>

      <SheetContent side="right" className="w-[min(440px,94vw)] gap-0 p-0 sm:max-w-[440px]">
        <SheetHeader className="border-b border-border/60 px-4 py-4 pr-12">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-sky-700">
            <TerminalSquare className="h-4 w-4" />
            Execution Runner
          </div>
          <SheetTitle>Project / session execution</SheetTitle>
          <SheetDescription>
            Codex authentication stays on the runner machine. Nodes stores only project/session execution context.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <section className="rounded-2xl border border-border/60 bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Runner readiness</p>
              <Button type="button" variant="outline" size="sm" className="h-8 gap-2" disabled={checking} onClick={() => void refreshStatus()}>
                <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
                Check again
              </Button>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {statusPill(Boolean(status?.reachable), "Runner online", "Runner offline")}
              {statusPill(Boolean(status?.authenticated), "Codex authenticated", "Authentication required")}
              {statusPill(workspaceReady, "Workspace configured", "Workspace required")}
            </div>

            <div className="mt-3 rounded-xl border border-border/60 bg-background p-3">
              <div className="flex items-start gap-2">
                {status?.nextStep.code === "ready" ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : (
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {status?.nextStep.title ?? (checking ? "Checking runner…" : "Check runner status")}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {status?.nextStep.detail ?? "Nodes will tell you exactly what must be done before this workload can run."}
                  </p>
                  {status?.nextStep.command ? (
                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2 py-2">
                      <code className="min-w-0 flex-1 truncate text-xs">{status.nextStep.command}</code>
                      <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => void copyCommand(status.nextStep.command!)} aria-label="Copy authentication command">
                        <Clipboard className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            {status?.model ? (
              <p className="mt-2 text-xs text-muted-foreground">Model: <span className="font-medium text-foreground">{status.model}</span></p>
            ) : null}
          </section>

          <section className="rounded-2xl border border-border/60 bg-background p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Selected workload</p>
            {selectedNode ? (
              <div className="mt-2">
                <p className="text-sm font-semibold text-foreground">{selectedNode.title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{selectedNode.description || "No workload description yet."}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                  <span className="rounded-full border border-border/60 px-2 py-1">status: {selectedNode.status}</span>
                  <span className="rounded-full border border-border/60 px-2 py-1">session: {selectedSessionId ? selectedSessionId.slice(0, 8) : "none"}</span>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Select a workload node on the Canvas. The runner acts only on the selected workload and its attached primary session.</p>
            )}
          </section>

          <section className="rounded-2xl border border-border/60 bg-background p-3">
            <label htmlFor="project-runner-workspace" className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Runner workspace</label>
            <Input
              id="project-runner-workspace"
              className="mt-2"
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.currentTarget.value)}
              placeholder={status?.hasDefaultWorkspace ? "Default workspace (leave blank)" : "Configured workspace id, e.g. tycho"}
            />
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              This is a project-local binding stored in this browser, not a credential. The runner resolves the ID through its server-side CODEX_WORKSPACES_JSON allowlist.
            </p>
          </section>

          {managedData ? (
            <section className="rounded-2xl border border-sky-500/20 bg-sky-500/[0.04] p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-sky-700">Managed run</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">{managedData.title ?? selectedNode?.title ?? "Codex workload"}</p>
                </div>
                <span className="rounded-full border border-border/60 bg-background px-2 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                  {managedData.agentStatus ?? "queued"}
                </span>
              </div>
              {managedData.agentOutput ? (
                <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap rounded-xl border border-border/60 bg-background p-3 text-xs leading-5 text-foreground">{managedData.agentOutput}</pre>
              ) : null}
              {managedData.agentError ? (
                <p className="mt-3 rounded-xl border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-xs text-rose-700">{managedData.agentError}</p>
              ) : null}
              {managedData.agentPendingApprovalId ? (
                <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3">
                  <p className="text-xs font-semibold text-amber-800">Codex is waiting for approval.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={() => managedData.onAgentApproval?.("accept")}>Approve once</Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => managedData.onAgentApproval?.("acceptForSession")}>Approve session</Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => managedData.onAgentApproval?.("decline")}>Decline</Button>
                  </div>
                </div>
              ) : null}
              {managedData.agentStatus && !["completed", "failed", "cancelled"].includes(managedData.agentStatus) ? (
                <Button type="button" variant="outline" size="sm" className="mt-3 gap-2" onClick={() => managedData.onAgentCancel?.()}>
                  <Square className="h-3.5 w-3.5" />
                  Cancel run
                </Button>
              ) : null}
            </section>
          ) : null}

          <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <p className="text-xs leading-5 text-muted-foreground">
                Authentication files never pass through the project, session, Supabase, or browser. Managed runs persist in the session Codex snapshot and use the existing SSE, cancel, and approval flow.
              </p>
            </div>
          </section>

          {message ? <p className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 text-foreground">{message}</p> : null}
        </div>

        <SheetFooter className="border-t border-border/60 p-4">
          <Button type="button" className="w-full gap-2" disabled={!canRun || runBusy} onClick={runSelectedWorkload}>
            {runBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {runBusy ? "Workload active…" : "Run selected workload"}
          </Button>
          {!canRun ? (
            <p className="text-center text-[11px] leading-4 text-muted-foreground">
              Run unlocks after runner + authentication + workspace + selected session are ready.
            </p>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
