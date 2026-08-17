"use client";

import React from "react";
import { Activity, RefreshCw, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProjects } from "@/components/context/projects";
import type { ProjectArenaExperimentEntry } from "@/lib/project-arena-experiments";

type ExperimentResponse = {
  entries?: ProjectArenaExperimentEntry[];
  error?: string;
  reason?: string;
  winner?: {
    experimentId: string;
    candidateId: string;
    title: string;
  };
};

const metric = (value: number | null, suffix = "") =>
  value === null || !Number.isFinite(value) ? "—" : `${value}${suffix}`;

export function ProjectArenaExperimentPanel() {
  const { activeProject } = useProjects();
  const [entries, setEntries] = React.useState<ProjectArenaExperimentEntry[]>([]);
  const [state, setState] = React.useState<"idle" | "loading" | "ready" | "error">("idle");
  const [promotingId, setPromotingId] = React.useState<string | null>(null);
  const [controlMessage, setControlMessage] = React.useState<string | null>(null);
  const [controlError, setControlError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!activeProject || activeProject.accessRole !== "owner") {
      setEntries([]);
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
      setState("ready");
    } catch {
      setEntries([]);
      setState("error");
    }
  }, [activeProject]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const experiments = React.useMemo(() => {
    const grouped = new Map<string, ProjectArenaExperimentEntry[]>();
    for (const entry of entries) {
      const current = grouped.get(entry.experimentId) ?? [];
      current.push(entry);
      grouped.set(entry.experimentId, current);
    }
    return [...grouped.entries()];
  }, [entries]);

  const promoteBest = React.useCallback(async (experimentId: string) => {
    if (!activeProject || activeProject.accessRole !== "owner") return;
    setPromotingId(experimentId);
    setControlError(null);
    setControlMessage(null);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(activeProject.id)}/experiments`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "promote-best", experimentId }),
        },
      );
      const payload = (await response.json().catch(() => null)) as ExperimentResponse | null;
      if (!response.ok) {
        throw new Error(payload?.error || `Experiment promotion failed (${response.status}).`);
      }
      setEntries(Array.isArray(payload?.entries) ? payload.entries : []);
      setControlMessage(
        payload?.winner
          ? `${payload.winner.title} is now the promoted Arena champion for ${experimentId}.`
          : payload?.reason || "Arena promotion recorded.",
      );
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "Experiment promotion failed.");
    } finally {
      setPromotingId(null);
    }
  }, [activeProject]);

  if (!activeProject || activeProject.accessRole !== "owner") return null;

  return (
    <section className="rounded-3xl border border-border/60 bg-background/90 px-4 py-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-sky-700" />
          <div>
            <p className="text-sm font-semibold text-foreground">Experimental runtime</p>
            <p className="text-xs text-muted-foreground">
              Durable challengers with Tycho quality, cost, latency, and promotion evidence.
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
          disabled={state === "loading" || promotingId !== null}
          onClick={() => void load()}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${state === "loading" ? "animate-spin" : ""}`} />
        </Button>
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

            return (
              <div key={experimentId} className="rounded-2xl border border-border/60 bg-muted/10 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-foreground">{experimentId}</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {completed.length}/{candidates.length} completed · measured {fullyMeasured.length}/{candidates.length} · cost ${totalCost.toFixed(4)} · tokens {totalTokens}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={hasChampion ? "outline" : "default"}
                    className="gap-1.5"
                    disabled={!promotionReady || promotingId !== null}
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
                        <span className="text-xs font-semibold text-foreground">
                          utility {entry.utility === null ? "—" : entry.utility.toFixed(3)}
                        </span>
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
