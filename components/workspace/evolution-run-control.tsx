"use client";

import * as React from "react";
import { PlayIcon } from "lucide-react";
import { usePersistedSessions } from "@/components/context/persisted-sessions";
import { useSessionArtifacts } from "@/components/context/session-artifacts";
import { Button } from "@/components/ui/button";
import { getEvolutionSessionArtifact } from "@/lib/tycho/evolution-session-snapshot";

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

export function EvolutionRunControl() {
  const { activeSessionId } = usePersistedSessions();
  const { artifacts } = useSessionArtifacts();
  const [workspaceId, setWorkspaceId] = React.useState("");
  const [projectId, setProjectId] = React.useState("");
  const [generations, setGenerations] = React.useState(2);
  const [populationSize, setPopulationSize] = React.useState(3);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const hasHistory = Boolean(getEvolutionSessionArtifact(artifacts));
  const protocolReady = hasTychoProtocol(artifacts);

  if (hasHistory) {
    return (
      <div className="rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        This Session already has an evolution history. A second launch is disabled so the persisted lineage is not overwritten.
      </div>
    );
  }

  const startEvolution = async () => {
    if (!activeSessionId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/evolution/run?sessionId=${encodeURIComponent(activeSessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspaceId.trim(),
          projectId: projectId.trim() || undefined,
          generations,
          populationSize,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { error?: string; status?: string; finalWinner?: { candidateKey: string; score: number | null } | null }
        | null;
      if (!response.ok) throw new Error(data?.error || `Evolution launch failed: ${response.status}`);
      setMessage(
        data?.finalWinner
          ? `Evolution ${data.status ?? "completed"}. Winner ${data.finalWinner.candidateKey}${data.finalWinner.score === null ? "" : ` · score ${data.finalWinner.score.toFixed(3)}`}.`
          : `Evolution ${data?.status ?? "completed"}.`,
      );
      window.setTimeout(() => window.location.reload(), 700);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Evolution launch failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border/60 bg-background/90 shadow-sm">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">Run evolution</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Codex generates hypotheses; Tycho executes candidates in isolated workspaces; the evaluator promotes one winner per generation.
        </p>
      </div>
      <div className="space-y-4 px-4 py-4">
        {!protocolReady ? (
          <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            Attach a valid .nodes/tycho-experiment.json artifact to this Session before launching evolution.
          </p>
        ) : null}

        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Runner workspace ID</span>
          <input
            value={workspaceId}
            onChange={(event) => setWorkspaceId(event.target.value)}
            placeholder="project/workspace allowlist key"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <label className="space-y-1 text-xs text-muted-foreground">
          <span>Project ID (optional)</span>
          <input
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            placeholder="project id for provenance"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Generations" value={generations} min={1} max={6} onChange={setGenerations} />
          <NumberField label="Population / generation" value={populationSize} min={1} max={12} onChange={setPopulationSize} />
        </div>

        <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Maximum configured budget: 6 generations × 12 candidates. Candidate runs remain bounded by the server-side Tycho timeout.
        </div>

        {error ? <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p> : null}
        {message ? <p className="text-xs text-emerald-700 dark:text-emerald-300">{message}</p> : null}

        <Button
          type="button"
          className="gap-2"
          disabled={busy || !activeSessionId || !protocolReady || !workspaceId.trim()}
          onClick={() => void startEvolution()}
        >
          <PlayIcon className="h-4 w-4" />
          {busy ? "Evolution running…" : "Start evolution"}
        </Button>
      </div>
    </section>
  );
}
