"use client";

import React from "react";
import { Activity, Play, RefreshCw, Square, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProjects } from "@/components/context/projects";
import type {
  ArenaExperimentPlan,
  ExperimentRunRecord,
} from "@/lib/agent-experiments";
import type { ProjectArenaExperimentEntry } from "@/lib/project-arena-experiments";

type ExperimentResponse = {
  entries?: ProjectArenaExperimentEntry[];
  records?: ExperimentRunRecord[];
  plan?: ArenaExperimentPlan;
  error?: string;
  reason?: string;
  winner?: {
    experimentId: string;
    candidateId: string;
    title: string;
  };
  cancelled?: {
    experimentId: string;
    candidateId: string;
    runId: string | null;
  };
};

type RuntimeStartResponse = {
  runId?: string;
  error?: string;
};

const metric = (value: number | null, suffix = "") =>
  value === null || !Number.isFinite(value) ? "—" : `${value}${suffix}`;

const experimentPhase = (candidates: ProjectArenaExperimentEntry[]) => {
  if (candidates.some((entry) => entry.promotion === "champion")) return "decided";
  if (candidates.some((entry) => entry.status === "running")) return "running";
  if (candidates.some((entry) => entry.status === "planned" || entry.status === "queued")) {
    return "planned";
  }
  if (candidates.every((entry) => entry.status === "completed")) {
    return candidates.every((entry) => entry.utility !== null) ? "ready to decide" : "evaluating";
  }
  if (candidates.every((entry) => ["failed", "cancelled"].includes(entry.status))) return "stopped";
  return "partial";
};

const experimentIdNow = () =>
  `arena-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export function ProjectArenaExperimentPanel() {
  const { activeProject } = useProjects();
  const [entries, setEntries] = React.useState<ProjectArenaExperimentEntry[]>([]);
  const [records, setRecords] = React.useState<ExperimentRunRecord[]>([]);
  const [state, setState] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [promotingId, setPromotingId] = React.useState<string | null>(null);
  const [controllingKey, setControllingKey] = React.useState<string | null>(null);
  const [launching, setLaunching] = React.useState(false);
  const [sourceKey, setSourceKey] = React.useState("");
  const [challengerRuntime, setChallengerRuntime] = React.useState<"codex" | "nooa">("codex");
  const [challengerModel, setChallengerModel] = React.useState("");
  const [challengerPrompt, setChallengerPrompt] = React.useState("");
  const [sandboxPolicyId, setSandboxPolicyId] = React.useState("");
  const [controlMessage, setControlMessage] = React.useState<string | null>(null);
  const [controlError, setControlError] = React.useState<string | null>(null);

  const applyPayload = React.useCallback((payload: ExperimentResponse | null) => {
    if (Array.isArray(payload?.entries)) setEntries(payload.entries);
    if (Array.isArray(payload?.records)) setRecords(payload.records);
  }, []);

  const load = React.useCallback(async () => {
    if (!activeProject || activeProject.accessRole !== "owner") {
      setEntries([]);
      setRecords([]);
      setState("idle");
      return;
    }
    setState("loading");
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(activeProject.id)}/experiments`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`Experiment request failed (${response.status}).`);
      const payload = (await response.json()) as ExperimentResponse;
      setEntries(Array.isArray(payload.entries) ? payload.entries : []);
      setRecords(Array.isArray(payload.records) ? payload.records : []);
      setState("ready");
    } catch {
      setEntries([]);
      setRecords([]);
      setState("error");
    }
  }, [activeProject]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!entries.some((entry) => entry.status === "running")) return undefined;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [entries, load]);

  const launchSources = React.useMemo(
    () => records.filter((record) => record.status === "completed" && Boolean(record.runId)),
    [records],
  );

  React.useEffect(() => {
    if (launchSources.length === 0) {
      setSourceKey("");
      return;
    }
    if (!launchSources.some((record) => `${record.experimentId}:${record.candidateId}` === sourceKey)) {
      const first = launchSources[0]!;
      setSourceKey(`${first.experimentId}:${first.candidateId}`);
      setChallengerPrompt(first.prompt);
      setChallengerModel(first.model ?? "");
    }
  }, [launchSources, sourceKey]);

  const sourceRecord = React.useMemo(
    () => launchSources.find(
      (record) => `${record.experimentId}:${record.candidateId}` === sourceKey,
    ) ?? null,
    [launchSources, sourceKey],
  );

  const experiments = React.useMemo(() => {
    const grouped = new Map<string, ProjectArenaExperimentEntry[]>();
    for (const entry of entries) {
      const current = grouped.get(entry.experimentId) ?? [];
      current.push(entry);
      grouped.set(entry.experimentId, current);
    }
    return [...grouped.entries()];
  }, [entries]);

  const postControl = React.useCallback(async (
    body: Record<string, unknown>,
  ): Promise<ExperimentResponse> => {
    if (!activeProject || activeProject.accessRole !== "owner") {
      throw new Error("Project owner access is required.");
    }
    const response = await fetch(
      `/api/projects/${encodeURIComponent(activeProject.id)}/experiments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const payload = (await response.json().catch(() => null)) as ExperimentResponse | null;
    if (!response.ok) {
      throw new Error(payload?.error || `Experiment control failed (${response.status}).`);
    }
    applyPayload(payload);
    return payload ?? {};
  }, [activeProject, applyPayload]);

  const promoteBest = React.useCallback(async (experimentId: string) => {
    setPromotingId(experimentId);
    setControlError(null);
    setControlMessage(null);
    try {
      const payload = await postControl({ action: "promote-best", experimentId });
      setControlMessage(
        payload.winner
          ? `${payload.winner.title} is now the promoted Arena champion for ${experimentId}.`
          : payload.reason || "Arena promotion recorded.",
      );
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "Experiment promotion failed.");
    } finally {
      setPromotingId(null);
    }
  }, [postControl]);

  const cancelCandidate = React.useCallback(async (entry: ProjectArenaExperimentEntry) => {
    setControllingKey(entry.key);
    setControlError(null);
    setControlMessage(null);
    try {
      await postControl({
        action: "cancel-candidate",
        experimentId: entry.experimentId,
        candidateId: entry.candidateId,
      });
      setControlMessage(`${entry.title} was cancelled and its durable experiment state was updated.`);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "Candidate cancellation failed.");
    } finally {
      setControllingKey(null);
    }
  }, [postControl]);

  const startCandidate = React.useCallback(async (
    experimentId: string,
    candidate: ArenaExperimentPlan["candidates"][number],
  ) => {
    const run = candidate.run;
    const endpoint = run.runtime === "codex" ? "/api/agents/codex/runs" : "/api/agents/nooa/runs";
    const model = typeof run.metadata?.model === "string" ? run.metadata.model : null;
    const requestBody = run.runtime === "codex"
      ? {
          sessionId: run.sessionId,
          prompt: run.prompt,
          projectId: run.projectId,
          workspaceId: run.workspaceId,
          parentRunId: run.parentRunId,
          continuation: run.continuation,
          role: run.role,
          label: run.label,
          metadata: run.metadata,
          model,
        }
      : run;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const payload = (await response.json().catch(() => null)) as RuntimeStartResponse | null;
      const runId = typeof payload?.runId === "string" ? payload.runId.trim() : "";
      if (!response.ok || !runId) {
        throw new Error(payload?.error || `Runtime start failed (${response.status}).`);
      }
      await postControl({
        action: "bind-candidate",
        experimentId,
        candidateId: candidate.id,
        runId,
      });
      return { candidateId: candidate.id, ok: true as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Runtime start failed.";
      await postControl({
        action: "fail-candidate",
        experimentId,
        candidateId: candidate.id,
        failureMessage: message,
      }).catch(() => undefined);
      return { candidateId: candidate.id, ok: false as const, message };
    }
  }, [postControl]);

  const launchExperiment = React.useCallback(async () => {
    if (!sourceRecord?.runId || !activeProject) return;
    const prompt = challengerPrompt.trim();
    if (!prompt) {
      setControlError("A challenger prompt is required.");
      return;
    }
    if (
      (sourceRecord.runtime === "nooa" || challengerRuntime === "nooa") &&
      !sandboxPolicyId.trim()
    ) {
      setControlError("An OpenShell policy ID is required for NOOA candidates.");
      return;
    }

    setLaunching(true);
    setControlError(null);
    setControlMessage(null);
    const experimentId = experimentIdNow();
    try {
      const payload = await postControl({
        action: "plan-challengers",
        experimentId,
        championRuntime: sourceRecord.runtime,
        championRunId: sourceRecord.runId,
        challengers: [
          {
            id: "control",
            title: "Control fork",
            runtime: sourceRecord.runtime,
            sessionId: sourceRecord.sessionId,
            prompt: sourceRecord.prompt,
            model: sourceRecord.model,
            role: sourceRecord.runtime === "codex" ? "coder" : "custom",
            sandboxPolicyId:
              sourceRecord.runtime === "nooa" ? sandboxPolicyId.trim() : undefined,
          },
          {
            id: "challenger",
            title: "Challenger",
            runtime: challengerRuntime,
            sessionId: sourceRecord.sessionId,
            prompt,
            model: challengerModel.trim() || null,
            role: challengerRuntime === "codex" ? "coder" : "custom",
            sandboxPolicyId:
              challengerRuntime === "nooa" ? sandboxPolicyId.trim() : undefined,
          },
        ],
      });
      if (!payload.plan || payload.plan.candidates.length !== 2) {
        throw new Error("Arena returned an invalid experiment launch plan.");
      }

      const results = await Promise.all(
        payload.plan.candidates.map((candidate) => startCandidate(experimentId, candidate)),
      );
      await load();
      const failures = results.filter((result) => !result.ok);
      setControlMessage(
        failures.length === 0
          ? `${experimentId} launched: Control fork and Challenger are running from the same durable parent.`
          : `${experimentId} was planned, but ${failures.length} candidate launch${failures.length === 1 ? "" : "es"} failed. The durable records were preserved for diagnosis.`,
      );
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "Experiment launch failed.");
      await load();
    } finally {
      setLaunching(false);
    }
  }, [
    activeProject,
    challengerModel,
    challengerPrompt,
    challengerRuntime,
    load,
    postControl,
    sandboxPolicyId,
    sourceRecord,
    startCandidate,
  ]);

  if (!activeProject || activeProject.accessRole !== "owner") return null;

  const controlBusy = promotingId !== null || controllingKey !== null || launching;

  return (
    <section className="rounded-3xl border border-border/60 bg-background/90 px-4 py-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-sky-700" />
          <div>
            <p className="text-sm font-semibold text-foreground">Experimental runtime</p>
            <p className="text-xs text-muted-foreground">
              Durable A/B challengers with live status, Tycho quality, cost, latency, cancellation, and promotion evidence.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          aria-label="Refresh experiment evidence"
          title="Refresh experiment evidence"
          disabled={state === "loading" || controlBusy}
          onClick={() => void load()}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${state === "loading" ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="mt-4 rounded-2xl border border-border/60 bg-muted/10 p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold text-foreground">Launch A/B experiment</p>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              Fork one completed run twice: preserve a control and vary the challenger without mutating the parent.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={!sourceRecord || controlBusy}
            onClick={() => void launchExperiment()}
          >
            <Play className="h-3.5 w-3.5" />
            {launching ? "Launching…" : "Launch A/B"}
          </Button>
        </div>

        {launchSources.length === 0 ? (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Complete at least one durable experiment run before launching a child A/B experiment from Arena.
          </p>
        ) : (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] text-muted-foreground">
              Parent run
              <select
                className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                value={sourceKey}
                disabled={controlBusy}
                onChange={(event) => {
                  const key = event.target.value;
                  setSourceKey(key);
                  const next = launchSources.find(
                    (record) => `${record.experimentId}:${record.candidateId}` === key,
                  );
                  if (next) {
                    setChallengerPrompt(next.prompt);
                    setChallengerModel(next.model ?? "");
                  }
                }}
              >
                {launchSources.map((record) => (
                  <option
                    key={`${record.experimentId}:${record.candidateId}`}
                    value={`${record.experimentId}:${record.candidateId}`}
                  >
                    {record.title} · {record.runtime} · {record.experimentId}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-[11px] text-muted-foreground">
              Challenger runtime
              <select
                className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                value={challengerRuntime}
                disabled={controlBusy}
                onChange={(event) =>
                  setChallengerRuntime(event.target.value === "nooa" ? "nooa" : "codex")
                }
              >
                <option value="codex">Codex</option>
                <option value="nooa">NOOA</option>
              </select>
            </label>

            <label className="text-[11px] text-muted-foreground sm:col-span-2">
              Challenger prompt
              <textarea
                className="mt-1 min-h-20 w-full rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground"
                value={challengerPrompt}
                disabled={controlBusy}
                onChange={(event) => setChallengerPrompt(event.target.value)}
              />
            </label>

            <label className="text-[11px] text-muted-foreground">
              Challenger model <span className="opacity-70">(optional)</span>
              <input
                className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                value={challengerModel}
                disabled={controlBusy || challengerRuntime === "nooa"}
                placeholder="Runner default"
                onChange={(event) => setChallengerModel(event.target.value)}
              />
            </label>

            {sourceRecord?.runtime === "nooa" || challengerRuntime === "nooa" ? (
              <label className="text-[11px] text-muted-foreground">
                OpenShell policy ID
                <input
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-xs text-foreground"
                  value={sandboxPolicyId}
                  disabled={controlBusy}
                  placeholder="Required for NOOA"
                  onChange={(event) => setSandboxPolicyId(event.target.value)}
                />
              </label>
            ) : null}
          </div>
        )}
      </div>

      {controlError ? (
        <p className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
          {controlError}
        </p>
      ) : null}
      {controlMessage ? (
        <p className="mt-3 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {controlMessage}
        </p>
      ) : null}

      {state === "error" ? (
        <p className="mt-3 text-xs text-rose-700">Experiment evidence could not be loaded.</p>
      ) : entries.length === 0 ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          No durable experiment candidates have been recorded for this project yet.
        </p>
      ) : (
        <div className="mt-3 space-y-4">
          {experiments.map(([experimentId, candidates]) => {
            const completed = candidates.filter((entry) => entry.status === "completed");
            const fullyMeasured = candidates.filter((entry) => entry.utility !== null);
            const hasChampion = candidates.some((entry) => entry.promotion === "champion");
            const promotionReady =
              candidates.length >= 2 &&
              completed.length === candidates.length &&
              fullyMeasured.length === candidates.length &&
              !hasChampion;
            const totalCost = candidates.reduce(
              (sum, entry) => sum + (entry.costUsd ?? 0),
              0,
            );
            const totalTokens = candidates.reduce(
              (sum, entry) => sum + entry.inputTokens + entry.outputTokens,
              0,
            );
            const phase = experimentPhase(candidates);

            return (
              <div key={experimentId} className="rounded-2xl border border-border/60 bg-muted/10 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs font-semibold text-foreground">{experimentId}</p>
                      <span className="rounded-full border border-border/60 bg-background/80 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                        {phase}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {completed.length}/{candidates.length} completed · measured {fullyMeasured.length}/{candidates.length} · cost ${totalCost.toFixed(4)} · tokens {totalTokens}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={hasChampion ? "outline" : "default"}
                    className="gap-1.5"
                    disabled={!promotionReady || controlBusy}
                    title={
                      hasChampion
                        ? "This experiment already has a promoted champion."
                        : promotionReady
                          ? "Promote the highest evidence-backed Arena utility."
                          : "All candidates need completed Tycho quality, cost, and latency evidence first."
                    }
                    onClick={() => void promoteBest(experimentId)}
                  >
                    <Trophy className="h-3.5 w-3.5" />
                    {promotingId === experimentId
                      ? "Promoting…"
                      : hasChampion
                        ? "Champion recorded"
                        : "Promote best"}
                  </Button>
                </div>

                <div className="mt-3 space-y-2">
                  {candidates.map((entry) => (
                    <article
                      key={entry.key}
                      className="rounded-2xl border border-border/60 bg-background/70 px-3 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold text-foreground">{entry.title}</p>
                            <span className="rounded-full border border-border/60 bg-background/80 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                              {entry.runtime}
                            </span>
                            {entry.promotion !== "undecided" ? (
                              <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-sky-700">
                                {entry.promotion}
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {entry.candidateId} · {entry.status}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {entry.status === "running" && entry.runId ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 px-2 text-[11px]"
                              disabled={controlBusy}
                              onClick={() => void cancelCandidate(entry)}
                            >
                              <Square className="h-3 w-3" />
                              {controllingKey === entry.key ? "Cancelling…" : "Cancel"}
                            </Button>
                          ) : null}
                          <span className="text-xs font-semibold text-foreground">
                            utility {entry.utility === null ? "—" : entry.utility.toFixed(3)}
                          </span>
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                        <div><span className="text-muted-foreground">Tycho </span>{metric(entry.qualityScore)}</div>
                        <div><span className="text-muted-foreground">Cost </span>{entry.costUsd === null ? "—" : `$${entry.costUsd.toFixed(4)}`}</div>
                        <div><span className="text-muted-foreground">Latency </span>{metric(entry.latencyMs, " ms")}</div>
                        <div><span className="text-muted-foreground">Tokens </span>{entry.inputTokens + entry.outputTokens}</div>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
