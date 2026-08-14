"use client";

import React from "react";
import { createPortal } from "react-dom";
import {
  Check,
  CheckCircle2,
  CircleAlert,
  Copy,
  Loader2,
  PanelRightOpen,
  Play,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Square,
  TerminalSquare,
} from "lucide-react";
import { useCodexAgentRuns } from "@/components/assistant-ui/thread-graph-flow/use-codex-agent-runs";
import { Button } from "@/components/ui/button";
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
import { buildProjectExecutionPrompt } from "@/lib/agents/codex/project-execution-context";
import type { ProjectDocument } from "@/lib/project-documents";
import {
  buildProjectMapInputSummary,
  getProjectMapNode,
  normalizeProjectMap,
} from "@/lib/project-map";
import type { SessionDocument } from "@/lib/session-documents";

type RunnerNextStep = {
  code:
    | "ready"
    | "configure_runner"
    | "start_runner"
    | "update_runner"
    | "authenticate"
    | "configure_workspace"
    | "configure_tycho";
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
  workspaceConfigured: boolean;
  tychoReady: boolean;
  tychoRuntime: string | null;
  tychoImage: string | null;
  tychoStatus: string | null;
  nextStep: RunnerNextStep;
};

type ManagedAgentData = {
  kind?: string;
  title?: string;
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
  const [preparing, setPreparing] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] = React.useState<PendingLaunch | null>(null);
  const [managedLocalId, setManagedLocalId] = React.useState<string | null>(null);
  const [agentOutputCopied, setAgentOutputCopied] = React.useState(false);
  const [headerActions, setHeaderActions] = React.useState<HTMLElement | null>(null);

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
  const managedNode = React.useMemo(() => {
    const selected = agentRunNodes.find((node) => node.id === managedLocalId);
    if (selected) return selected;
    const active = [...agentRunNodes].reverse().find((node) => {
      const agentStatus = (node.data as ManagedAgentData).agentStatus;
      return Boolean(agentStatus && !["completed", "failed", "cancelled"].includes(agentStatus));
    });
    return active ?? agentRunNodes.at(-1) ?? null;
  }, [agentRunNodes, managedLocalId]);
  const managedData = (managedNode?.data as ManagedAgentData | undefined) ?? null;
  const runBusy = Boolean(
    preparing ||
      pendingLaunch ||
      (managedData?.agentStatus && !["completed", "failed", "cancelled"].includes(managedData.agentStatus)),
  );

  React.useEffect(() => {
    const syncHeaderActions = () => {
      const refreshButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Refresh project canvas"]',
      );
      setHeaderActions(refreshButton?.parentElement ?? null);
    };

    syncHeaderActions();
    const observer = new MutationObserver(syncHeaderActions);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    setManagedLocalId(null);
    setPendingLaunch(null);
    setPreparing(false);
    setMessage(null);
  }, [selectedSessionId]);

  React.useEffect(() => {
    setAgentOutputCopied(false);
  }, [managedNode?.id, managedData?.agentOutput]);

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
        current ? { ...current, localId: created.id, stage: "await-prompt" } : null,
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
    setMessage(
      "Managed Codex run started with the selected session artifacts/runbook. Output, approvals, cancellation, and reconnect state are attached to this session.",
    );
  }, [agentRunNodes, pendingLaunch]);

  const refreshStatus = React.useCallback(async () => {
    setChecking(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/agents/codex/status?workspaceId=${encodeURIComponent(project.id)}`,
        {
          method: "GET",
          cache: "no-store",
        },
      );
      const body = (await response.json().catch(() => null)) as RunnerStatus | null;
      if (!response.ok || !body) throw new Error(`Runner status failed: ${response.status}`);
      setStatus(body);
    } catch (error) {
      setStatus(null);
      setMessage(error instanceof Error ? error.message : "Unable to check runner status.");
    } finally {
      setChecking(false);
    }
  }, [project.id]);

  React.useEffect(() => {
    if (!open) return;
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 30_000);
    return () => window.clearInterval(timer);
  }, [open, refreshStatus]);

  const workspaceReady = Boolean(status?.workspaceConfigured);
  const tychoReady = Boolean(status?.tychoReady);
  const canRun = Boolean(
    project.accessRole === "owner" &&
      status?.reachable &&
      status.codexRunning &&
      status.authenticated &&
      workspaceReady &&
      tychoReady &&
      selectedNode &&
      selectedSessionId,
  );

  const effectiveNextStep = status?.nextStep ?? null;

  const copyAgentOutput = React.useCallback(async () => {
    if (!managedData?.agentOutput) return;
    try {
      await navigator.clipboard.writeText(managedData.agentOutput);
      setAgentOutputCopied(true);
    } catch {
      setAgentOutputCopied(false);
      setMessage("Unable to copy the agent result. Select the result text and copy it manually.");
    }
  }, [managedData?.agentOutput]);

  const runSelectedWorkload = React.useCallback(async () => {
    if (!selectedNode || !selectedSessionId || !canRun || runBusy) return;
    setPreparing(true);
    setMessage("Loading the selected session artifacts and execution runbook…");

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}`, {
        method: "GET",
        cache: "no-store",
      });
      const body = (await response.json().catch(() => null)) as { session?: SessionDocument } | null;
      if (!response.ok || !body?.session) {
        throw new Error(`Unable to load execution session (${response.status}).`);
      }

      const prompt = buildProjectExecutionPrompt({
        projectId: project.id,
        projectTitle: project.title ?? project.id,
        workloadTitle: selectedNode.title,
        workloadDescription: selectedNode.description,
        upstreamSummary,
        artifacts: body.session.artifacts,
      });

      setPendingLaunch({
        existingIds: new Set(agentRunNodes.map((node) => node.id)),
        prompt,
        stage: "await-node",
      });
      managedRuns.addAgent();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to prepare the workload execution context.");
    } finally {
      setPreparing(false);
    }
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
  ]);

  if (project.accessRole !== "owner") return null;

  const runnerTrigger = (
    <SheetTrigger asChild>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={headerActions ? "gap-2" : "absolute right-4 top-4 z-30 gap-2 bg-background/95 shadow-sm backdrop-blur"}
        aria-label="Open execution runner"
      >
        <PanelRightOpen className="h-4 w-4" />
        Runner
      </Button>
    </SheetTrigger>
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {headerActions ? createPortal(runnerTrigger, headerActions) : runnerTrigger}

      <SheetContent side="right" className="w-[min(440px,94vw)] gap-0 p-0 sm:max-w-[440px]">
        <SheetHeader className="border-b border-border/60 px-4 py-4 pr-12">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-sky-700">
            <TerminalSquare className="h-4 w-4" />
            Execution Runner
          </div>
          <SheetTitle>Project / session execution</SheetTitle>
          <SheetDescription>
            Codex authentication stays on the runner machine. Tycho experiment execution must pass isolated Docker/Finch readiness before this branch enables Run.
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
              {statusPill(workspaceReady, "Project workspace mapped", "Project workspace required")}
              {statusPill(tychoReady, "Tycho isolated", "Tycho required")}
            </div>

            <div className="mt-3 rounded-xl border border-border/60 bg-background p-3">
              <div className="flex items-start gap-2">
                {effectiveNextStep?.code === "ready" ? (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                ) : (
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                )}
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    {effectiveNextStep?.title ?? (checking ? "Checking runner…" : "Check runner status")}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {effectiveNextStep?.detail ?? "Nodes will tell you exactly what must be done before this workload can run."}
                  </p>
                  {effectiveNextStep?.code !== "ready" ? (
                    <Button type="button" variant="outline" size="sm" className="mt-2 gap-2" onClick={() => window.dispatchEvent(new Event("nodes:show-agent-work"))}>
                      <Settings2 className="h-3.5 w-3.5" />
                      Open Agent Work controls
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            {status?.model ? (
              <p className="mt-2 text-xs text-muted-foreground">Model: <span className="font-medium text-foreground">{status.model}</span></p>
            ) : null}
            {status?.tychoReady ? (
              <p className="mt-1 text-xs text-muted-foreground">
                Tycho: <span className="font-medium text-foreground">{status.tychoRuntime ?? "isolated"}</span>
                {status.tychoImage ? <> · <span className="font-medium text-foreground">{status.tychoImage}</span></> : null}
              </p>
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
                <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                  Primary-session artifacts are loaded fresh when the run starts and become authoritative execution context.
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm leading-6 text-muted-foreground">Select a workload node on the Canvas. The runner acts only on the selected workload and its attached primary session.</p>
            )}
          </section>

          <section className="rounded-2xl border border-border/60 bg-background p-3">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Runner workspace key</p>
            <code className="mt-2 block overflow-x-auto rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs">{project.id}</code>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Managed project runs use the project id as the workspace key. The runner verifies this exact key in CODEX_WORKSPACES_JSON; no filesystem path is accepted from the browser.
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
                <div className="relative mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="absolute right-2 top-2 z-10 h-8 w-8 bg-background/95"
                    aria-label={agentOutputCopied ? "Agent result copied" : "Copy agent result"}
                    title={agentOutputCopied ? "Copied" : "Copy agent result"}
                    onClick={() => void copyAgentOutput()}
                  >
                    {agentOutputCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                  <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-xl border border-border/60 bg-background p-3 pr-12 text-xs leading-5 text-foreground">{managedData.agentOutput}</pre>
                </div>
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
                Authentication files never pass through the project, session, Supabase, or browser. Tycho experiment scripts run only after the runner verifies an isolated Docker/Finch sandbox; host fallback is not accepted.
              </p>
            </div>
          </section>

          {message ? <p className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 text-foreground">{message}</p> : null}
        </div>

        <SheetFooter className="border-t border-border/60 p-4">
          <Button type="button" className="w-full gap-2" disabled={!canRun || runBusy} onClick={() => void runSelectedWorkload()}>
            {runBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {preparing ? "Preparing context…" : runBusy ? "Workload active…" : "Run selected workload"}
          </Button>
          {!canRun ? (
            <p className="text-center text-[11px] leading-4 text-muted-foreground">
              Run unlocks after runner + authentication + exact project workspace mapping + Tycho Docker/Finch isolation + selected session are ready.
            </p>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
