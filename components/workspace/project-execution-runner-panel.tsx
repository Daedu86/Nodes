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
  TerminalSquare,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type RunResponse = {
  runId?: string;
  status?: string;
  error?: string;
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
  const [running, setRunning] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = React.useState("");

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
    status?.reachable &&
      status.codexRunning &&
      status.authenticated &&
      workspaceReady &&
      selectedNode &&
      selectedSessionId &&
      (!needsExplicitWorkspace || workspaceId.trim()),
  );

  const runSelectedWorkload = React.useCallback(async () => {
    if (!selectedNode || !selectedSessionId || !canRun) return;
    setRunning(true);
    setMessage(null);
    const prompt = [
      "Execute this Nodes project workload in the configured workspace.",
      `Project: ${project.title ?? project.id}`,
      `Workload: ${selectedNode.title}`,
      selectedNode.description ? `Objective: ${selectedNode.description}` : "",
      upstreamSummary ? `Selected upstream outputs:\n${upstreamSummary}` : "",
      "Use the repository/workspace as the source of truth. Preserve useful outputs as files/artifacts and report what was executed, verified, and what remains blocked. Do not expose local credentials or authentication files.",
    ]
      .filter(Boolean)
      .join("\n\n");

    try {
      const response = await fetch("/api/agents/codex/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: selectedSessionId,
          projectId: project.id,
          workspaceId: workspaceId.trim() || null,
          role: "coder",
          label: selectedNode.title,
          prompt,
          metadata: {
            source: "project-execution-runner-panel",
            mapNodeId: selectedNode.id,
          },
        }),
      });
      const body = (await response.json().catch(() => null)) as RunResponse | null;
      if (!response.ok) throw new Error(body?.error || `Unable to start run: ${response.status}`);
      setMessage(
        body?.runId
          ? `Run started (${body.runId.slice(0, 8)}). Open Agent Work to follow detailed activity and approvals.`
          : "Run started. Open Agent Work to follow detailed activity and approvals.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to start the workload.");
    } finally {
      setRunning(false);
    }
  }, [canRun, project.id, project.title, selectedNode, selectedSessionId, upstreamSummary, workspaceId]);

  const copyCommand = React.useCallback(async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setMessage(`Copied: ${command}`);
    } catch {
      setMessage(`Run this on the runner machine: ${command}`);
    }
  }, []);

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="absolute right-4 top-4 z-30 gap-2 bg-background/95 shadow-sm backdrop-blur"
        onClick={() => setOpen(true)}
        aria-label="Open execution runner"
      >
        <PanelRightOpen className="h-4 w-4" />
        Runner
      </Button>

      {open ? (
        <div className="absolute inset-y-0 right-0 z-50 flex w-[min(420px,94vw)] flex-col border-l border-border/70 bg-background/98 shadow-2xl backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-sky-700">
                <TerminalSquare className="h-4 w-4" />
                Execution Runner
              </div>
              <h2 className="mt-1 text-base font-semibold text-foreground">Project / session execution</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Codex authentication stays on the runner machine. Nodes stores only project/session execution context.
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setOpen(false)} aria-label="Close execution runner">
              <X className="h-4 w-4" />
            </Button>
          </div>

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

            <section className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                <p className="text-xs leading-5 text-muted-foreground">
                  Authentication files never pass through the project, session, Supabase, or browser. Run approvals continue through the existing Codex approval flow.
                </p>
              </div>
            </section>

            {message ? <p className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-5 text-foreground">{message}</p> : null}
          </div>

          <div className="border-t border-border/60 p-4">
            <Button type="button" className="w-full gap-2" disabled={!canRun || running} onClick={() => void runSelectedWorkload()}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? "Starting workload…" : "Run selected workload"}
            </Button>
            {!canRun ? (
              <p className="mt-2 text-center text-[11px] leading-4 text-muted-foreground">
                Run unlocks after runner + authentication + workspace + selected session are ready.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
