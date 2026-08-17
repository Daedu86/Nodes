"use client";

import React from "react";
import { Activity, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProjects } from "@/components/context/projects";
import type { ProjectArenaExperimentEntry } from "@/lib/project-arena-experiments";

type ExperimentResponse = {
  entries?: ProjectArenaExperimentEntry[];
};

const metric = (value: number | null, suffix = "") =>
  value === null || !Number.isFinite(value) ? "—" : `${value}${suffix}`;

export function ProjectArenaExperimentPanel() {
  const { activeProject } = useProjects();
  const [entries, setEntries] = React.useState<ProjectArenaExperimentEntry[]>([]);
  const [state, setState] = React.useState<"idle" | "loading" | "ready" | "error">("idle");

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
          disabled={state === "loading"}
          onClick={() => void load()}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${state === "loading" ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {state === "error" ? (
        <p className="mt-3 text-xs text-rose-700">Experiment evidence could not be loaded.</p>
      ) : entries.length === 0 ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          No durable experiment candidates have been recorded for this project yet.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {entries.map((entry) => (
            <article
              key={entry.key}
              className="rounded-2xl border border-border/60 bg-muted/20 px-3 py-3"
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
                    {entry.experimentId} · {entry.status}
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
      )}
    </section>
  );
}
