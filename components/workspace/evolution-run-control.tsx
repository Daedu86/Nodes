"use client";

import * as React from "react";
import { PlayIcon, RotateCwIcon, SquareIcon } from "lucide-react";
import { usePersistedSessions } from "@/components/context/persisted-sessions";
import { useSessionArtifacts } from "@/components/context/session-artifacts";
import { Button } from "@/components/ui/button";
import { getDurableEvolutionLifecycleSnapshot } from "@/lib/tycho/durable-evolution-snapshot";
import { getEvolutionSessionSnapshot } from "@/lib/tycho/evolution-session-snapshot";
import type { DurableEvolutionRunSnapshot } from "@/lib/tycho/evolution-runner-client";

const hasTychoProtocol = (artifacts: ReturnType<typeof useSessionArtifacts>["artifacts"]) =>
  artifacts.some(
    (artifact) =>
      artifact.fileName === ".nodes/tycho-experiment.json" ||
      artifact.title === ".nodes/tycho-experiment.json" ||
      artifact.title.toLowerCase().includes("tycho experiment"),
  );

const NumberField = ({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) => (
  <label className="space-y-1 text-xs text-muted-foreground">
    <span>{label}</span>
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
    />
  </label>
);

const terminalRun = (status: DurableEvolutionRunSnapshot["status"]) =>
  status === "completed" || status === "failed" || status === "cancelled";

export function EvolutionRunControl() {
  const { activeSessionId } = usePersistedSessions();
  const { artifacts } = useSessionArtifacts();
  const [workspaceId, setWorkspaceId] = React.useState("");
  const [projectId, setProjectId] = React.useState("");
  const [generations, setGenerations] = React.useState(4);
  const [populationSize, setPopulationSize] = React.useState(3);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [remoteRun, setRemoteRun] = React.useState<DurableEvolutionRunSnapshot | null>(null);

  const snapshot = getEvolutionSessionSnapshot(artifacts);
  const lifecycle = getDurableEvolutionLifecycleSnapshot(artifacts);
  const mode = snapshot ? "continue" : "start";
  const latestEpisode = snapshot?.episodes.at(-1) ?? null;
  const protocolReady = mode === "continue" || hasTychoProtocol(artifacts);
  const hasChampion = Boolean(snapshot?.champion && snapshot.champion.score !== null);
  const lifecycleActive = lifecycle?.status === "queued" || lifecycle?.status === "running";
  const run = remoteRun ?? (lifecycle ? {
    schemaVersion: 1 as const,
    runId: lifecycle.runId,
    sessionId: lifecycle.sessionId,
    projectId: snapshot?.projectId ?? null,
    workspaceId: lifecycle.workspaceId,
    episodeIndex: lifecycle.episodeIndex,
    status: lifecycle.status,
    phase: lifecycle.phase,
    requestedGenerations: lifecycle.requestedGenerations,
    populationSize: lifecycle.populationSize,
    startGeneration: lifecycle.startGeneration,
    nextGeneration: lifecycle.startGeneration + lifecycle.completedGenerations,
    completedGenerations: lifecycle.completedGenerations,
    generations: [],
    champion: null,
    reason: lifecycle.reason,
    activeGeneratorRunId: null,
    activeCandidateRunIds: [],
    cancelRequested: false,
    createdAt: lifecycle.createdAt,
    startedAt: null,
    updatedAt: lifecycle.updatedAt,
    finishedAt: lifecycle.finishedAt,
  } satisfies DurableEvolutionRunSnapshot : null);

  React.useEffect(() => {
    if (!workspaceId && (lifecycle?.workspaceId || latestEpisode?.workspaceId)) {
      setWorkspaceId(lifecycle?.workspaceId || latestEpisode?.workspaceId || "");
    }
    if (!projectId && snapshot?.projectId) setProjectId(snapshot.projectId);
  }, [latestEpisode?.workspaceId, lifecycle?.workspaceId, projectId, snapshot?.projectId, workspaceId]);

  React.useEffect(() => {
    if (!activeSessionId || !lifecycle) return;
    const shouldReconcile = lifecycleActive || snapshot?.status === "running";
    if (!shouldReconcile) return;
    let disposed = false;
    let terminalReloadScheduled = false;

    const poll = async () => {
      try {
        const response = await fetch(
          `/api/evolution/runs/${encodeURIComponent(lifecycle.runId)}?sessionId=${encodeURIComponent(activeSessionId)}`,
          { method: "GET", cache: "no-store" },
        );
        const data = (await response.json().catch(() => null)) as
          | { error?: string; run?: DurableEvolutionRunSnapshot }
          | null;
        if (!response.ok) throw new Error(data?.error || `Evolution status failed: ${response.status}`);
        if (disposed || !data?.run) return;
        setRemoteRun(data.run);
        setError(null);
        if (terminalRun(data.run.status) && !terminalReloadScheduled) {
          terminalReloadScheduled = true;
          setMessage(
            data.run.status === "completed"
              ? `Episode ${data.run.episodeIndex} completed with ${data.run.completedGenerations} checkpointed generation${data.run.completedGenerations === 1 ? "" : "s"}.`
              : `Episode ${data.run.episodeIndex} ${data.run.status}${data.run.reason ? `: ${data.run.reason}` : "."}`,
          );
          window.setTimeout(() => window.location.reload(), 900);
        }
      } catch (pollError) {
        if (!disposed) setError(pollError instanceof Error ? pollError.message : "Unable to reconnect evolution run.");
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [activeSessionId, lifecycle, lifecycleActive, snapshot?.status]);

  const startEvolution = async () => {
    if (!activeSessionId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/evolution/runs?sessionId=${encodeURIComponent(activeSessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          workspaceId: workspaceId.trim(),
          projectId: projectId.trim() || undefined,
          generations,
          populationSize,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { error?: string; run?: DurableEvolutionRunSnapshot }
        | null;
      if (!response.ok || !data?.run) {
        throw new Error(data?.error || `Evolution launch failed: ${response.status}`);
      }
      setRemoteRun(data.run);
      setMessage(
        `Episode ${data.run.episodeIndex} queued as ${data.run.runId.slice(0, 8)}…. You can close Canvas; the runner will continue and checkpoint progress locally.`,
      );
      window.setTimeout(() => window.location.reload(), 500);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Evolution launch failed.");
    } finally {
      setBusy(false);
    }
  };

  const cancelEvolution = async () => {
    if (!activeSessionId || !run) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/evolution/runs/${encodeURIComponent(run.runId)}/cancel?sessionId=${encodeURIComponent(activeSessionId)}`,
        { method: "POST" },
      );
      const data = (await response.json().catch(() => null)) as
        | { error?: string; run?: DurableEvolutionRunSnapshot }
        | null;
      if (!response.ok) throw new Error(data?.error || `Evolution cancel failed: ${response.status}`);
      if (data?.run) setRemoteRun(data.run);
      setMessage("Cancellation requested. Active Codex/Tycho child runs are being stopped.");
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Evolution cancellation failed.");
    } finally {
      setBusy(false);
    }
  };

  const activeRun = Boolean(run && !terminalRun(run.status));
  const canLaunch =
    !busy &&
    Boolean(activeSessionId) &&
    protocolReady &&
    Boolean(workspaceId.trim()) &&
    !activeRun &&
    snapshot?.status !== "running" &&
    (mode === "start" || hasChampion);
  const nextGeneration = snapshot?.champion ? snapshot.champion.generation + 1 : 1;

  return (
    <section className="rounded-2xl border border-border/60 bg-background/90 shadow-sm">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">
          {activeRun ? "Evolution running" : mode === "continue" ? "Continue evolution" : "Run evolution"}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {activeRun
            ? "This episode runs durably on the local runner. Canvas can disconnect and reconnect without stopping it."
            : mode === "continue"
              ? "Start a new append-only episode from the persisted champion and its reward evidence."
              : "Codex generates hypotheses; Tycho executes candidates in isolated workspaces; the evaluator promotes one winner per generation."}
        </p>
      </div>
      <div className="space-y-4 px-4 py-4">
        {mode === "start" && !protocolReady ? (
          <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            Attach a valid .nodes/tycho-experiment.json artifact to this Session before launching evolution.
          </p>
        ) : null}

        {run ? (
          <div className="space-y-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">
              Episode {run.episodeIndex} · {run.status} · {run.phase.replaceAll("_", " ")}
            </div>
            <div>
              {run.completedGenerations}/{run.requestedGenerations} generations checkpointed · population {run.populationSize}
            </div>
            <div>
              Range g{run.startGeneration}–g{run.startGeneration + run.requestedGenerations - 1}
              {run.status === "running" ? ` · next g${run.nextGeneration}` : ""}
            </div>
            <div className="font-mono text-[10px]">run {run.runId}</div>
            {run.reason ? <div className="text-amber-700 dark:text-amber-300">{run.reason}</div> : null}
          </div>
        ) : snapshot ? (
          <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">
              {snapshot.episodes.length} episode{snapshot.episodes.length === 1 ? "" : "s"} · {snapshot.generations.length} persisted generation{snapshot.generations.length === 1 ? "" : "s"}
            </div>
            {snapshot.champion ? (
              <div className="mt-1">
                Champion {snapshot.champion.candidateKey}
                {snapshot.champion.score === null ? "" : ` · score ${snapshot.champion.score.toFixed(3)}`} · next generation g{nextGeneration}
              </div>
            ) : (
              <div className="mt-1 text-amber-700 dark:text-amber-300">
                No scored champion is available yet, so continuation is blocked.
              </div>
            )}
          </div>
        ) : null}

        {snapshot?.status === "running" && !lifecycle ? (
          <p className="rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            This Session is marked running but has no durable lifecycle artifact. Do not start another episode until the stale state is repaired.
          </p>
        ) : null}

        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Runner workspace ID</span>
          <input
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            readOnly={activeRun}
            placeholder="project/workspace allowlist key"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring read-only:cursor-not-allowed read-only:opacity-70"
          />
        </label>

        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Project ID {snapshot?.projectId ? "(persisted)" : "(optional)"}</span>
          <input
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            readOnly={Boolean(snapshot?.projectId) || activeRun}
            placeholder="project id for provenance"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring read-only:cursor-not-allowed read-only:opacity-70"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Generations this episode" value={generations} min={1} max={50} onChange={setGenerations} />
          <NumberField label="Population / generation" value={populationSize} min={1} max={12} onChange={setPopulationSize} />
        </div>

        <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Episodes are no longer bounded by the Vercel request lifetime. The runner stores an atomic checkpoint after every terminal generation and resumes non-terminal episodes from the last checkpoint after a runner restart.
        </div>

        {error ? <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p> : null}
        {message ? <p className="text-xs text-emerald-700 dark:text-emerald-300">{message}</p> : null}

        <div className="flex flex-wrap gap-2">
          {activeRun ? (
            <Button
              type="button"
              className="gap-2"
              disabled={busy}
              onClick={() => void cancelEvolution()}
            >
              <SquareIcon className="h-4 w-4" />
              {busy ? "Cancelling…" : "Cancel evolution"}
            </Button>
          ) : (
            <Button
              type="button"
              className="gap-2"
              disabled={!canLaunch}
              onClick={() => void startEvolution()}
            >
              {mode === "continue" ? <RotateCwIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
              {busy
                ? mode === "continue" ? "Starting continuation…" : "Starting evolution…"
                : mode === "continue" ? "Continue from champion" : "Start evolution"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
