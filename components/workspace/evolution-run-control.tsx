"use client";

import * as React from "react";
import { PlayIcon, RotateCwIcon } from "lucide-react";
import { usePersistedSessions } from "@/components/context/persisted-sessions";
import { useSessionArtifacts } from "@/components/context/session-artifacts";
import { Button } from "@/components/ui/button";
import { getEvolutionSessionSnapshot } from "@/lib/tycho/evolution-session-snapshot";

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

  const snapshot = getEvolutionSessionSnapshot(artifacts);
  const mode = snapshot ? "continue" : "start";
  const latestEpisode = snapshot?.episodes.at(-1) ?? null;
  const protocolReady = mode === "continue" || hasTychoProtocol(artifacts);
  const hasChampion = Boolean(snapshot?.champion && snapshot.champion.score !== null);
  const evolutionRunning = snapshot?.status === "running";

  React.useEffect(() => {
    if (!workspaceId && latestEpisode?.workspaceId) setWorkspaceId(latestEpisode.workspaceId);
    if (!projectId && snapshot?.projectId) setProjectId(snapshot.projectId);
  }, [latestEpisode?.workspaceId, projectId, snapshot?.projectId, workspaceId]);

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
          mode,
          workspaceId: workspaceId.trim(),
          projectId: projectId.trim() || undefined,
          generations,
          populationSize,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | {
            error?: string;
            status?: string;
            episode?: {
              episodeId: string;
              index: number;
              startGeneration: number;
              endGeneration: number | null;
            } | null;
            finalWinner?: { candidateKey: string; score: number | null } | null;
          }
        | null;
      if (!response.ok) throw new Error(data?.error || `Evolution launch failed: ${response.status}`);
      const episodeLabel = data?.episode ? `Episode ${data.episode.index}` : "Evolution";
      setMessage(
        data?.finalWinner
          ? `${episodeLabel} ${data.status ?? "completed"}. Winner ${data.finalWinner.candidateKey}${data.finalWinner.score === null ? "" : ` · score ${data.finalWinner.score.toFixed(3)}`}.`
          : `${episodeLabel} ${data?.status ?? "completed"}.`,
      );
      window.setTimeout(() => window.location.reload(), 700);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Evolution launch failed.");
    } finally {
      setBusy(false);
    }
  };

  const canLaunch =
    !busy &&
    Boolean(activeSessionId) &&
    protocolReady &&
    Boolean(workspaceId.trim()) &&
    !evolutionRunning &&
    (mode === "start" || hasChampion);
  const nextGeneration = snapshot?.champion ? snapshot.champion.generation + 1 : 1;

  return (
    <section className="rounded-2xl border border-border/60 bg-background/90 shadow-sm">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold text-foreground">
          {mode === "continue" ? "Continue evolution" : "Run evolution"}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {mode === "continue"
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

        {snapshot ? (
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

        {evolutionRunning ? (
          <p className="rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            An evolution episode is already marked running for this Session. Wait for its terminal persisted state before starting another episode.
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
          <span>Project ID {snapshot?.projectId ? "(persisted)" : "(optional)"}</span>
          <input
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            readOnly={Boolean(snapshot?.projectId)}
            placeholder="project id for provenance"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring read-only:cursor-not-allowed read-only:opacity-70"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Generations this episode" value={generations} min={1} max={2} onChange={setGenerations} />
          <NumberField label="Population / generation" value={populationSize} min={1} max={12} onChange={setPopulationSize} />
        </div>

        <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          Each interactive episode is capped at 2 generations so the request stays within the 300-second hosting envelope. Episode history is appended; previous generations and champions are never overwritten.
        </div>

        {error ? <p className="text-xs text-rose-700 dark:text-rose-300">{error}</p> : null}
        {message ? <p className="text-xs text-emerald-700 dark:text-emerald-300">{message}</p> : null}

        <Button
          type="button"
          className="gap-2"
          disabled={!canLaunch}
          onClick={() => void startEvolution()}
        >
          {mode === "continue" ? <RotateCwIcon className="h-4 w-4" /> : <PlayIcon className="h-4 w-4" />}
          {busy
            ? mode === "continue" ? "Continuing evolution…" : "Evolution running…"
            : mode === "continue" ? "Continue from champion" : "Start evolution"}
        </Button>
      </div>
    </section>
  );
}
