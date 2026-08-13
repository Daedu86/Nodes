"use client";

import { GitBranchIcon, TrophyIcon } from "lucide-react";
import type { SessionArtifact } from "@/lib/session-artifacts";
import {
  getEvolutionSessionArtifact,
  getEvolutionSessionSnapshot,
  type EvolutionCandidateSnapshot,
  type EvolutionGenerationSnapshot,
} from "@/lib/tycho/evolution-session-snapshot";

const decisionClasses: Record<string, string> = {
  promote: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  reject: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  blocked: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  failed: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

const statusClasses: Record<string, string> = {
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  failed: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  running: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
};

const scoreLabel = (candidate: EvolutionCandidateSnapshot) =>
  candidate.score === null ? "—" : candidate.score.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");

const CandidateRow = ({ candidate }: { candidate: EvolutionCandidateSnapshot }) => {
  const status = candidate.decision ?? candidate.status;
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{candidate.candidateId}</span>
            {candidate.isWinner ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700 dark:text-emerald-300">
                <TrophyIcon className="h-3 w-3" /> winner
              </span>
            ) : null}
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] ${decisionClasses[status] ?? "border-border/60 bg-background/80 text-muted-foreground"}`}>
              {status}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {candidate.runId ? `run ${candidate.runId}` : candidate.error?.message ?? candidate.experimentId}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">score</p>
          <p className="text-sm font-semibold text-foreground">{scoreLabel(candidate)}</p>
        </div>
      </div>
      {candidate.metrics && Object.keys(candidate.metrics).length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {Object.entries(candidate.metrics).map(([key, value]) => (
            <span key={key} className="rounded-full border border-border/60 bg-background/80 px-2 py-0.5 text-[10px] text-muted-foreground">
              {key} {Number.isInteger(value) ? value : Number(value.toFixed(4))}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const GenerationDetails = ({ generation }: { generation: EvolutionGenerationSnapshot }) => (
  <details className="rounded-xl border border-border/60 bg-background">
    <summary className="cursor-pointer px-3 py-3 text-sm font-medium text-foreground">
      <span className="inline-flex flex-wrap items-center gap-2">
        Generation {generation.generation}
        <span className="text-xs font-normal text-muted-foreground">
          {generation.attempts.length}/{generation.requestedPopulation} candidates
        </span>
        {generation.winnerKey ? (
          <span className="text-xs font-normal text-emerald-700 dark:text-emerald-300">winner {generation.winnerKey}</span>
        ) : null}
      </span>
    </summary>
    <div className="space-y-2 border-t px-3 py-3">
      {generation.attempts.map((candidate) => (
        <CandidateRow key={candidate.candidateKey} candidate={candidate} />
      ))}
      {generation.error ? <p className="text-xs text-rose-700 dark:text-rose-300">{generation.error}</p> : null}
    </div>
  </details>
);

export function EvolutionSessionPanel({ artifacts }: { artifacts: SessionArtifact[] }) {
  const artifact = getEvolutionSessionArtifact(artifacts);
  if (!artifact) return null;

  const snapshot = getEvolutionSessionSnapshot(artifacts);
  if (!snapshot) {
    return (
      <section className="rounded-2xl border border-rose-500/30 bg-rose-500/5 shadow-sm">
        <div className="px-4 py-4">
          <h3 className="text-sm font-semibold text-rose-700 dark:text-rose-300">Evolution evidence is invalid</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            The stored {artifact.fileName} artifact does not satisfy the evolution-session-v2 contract or a migratable v1 contract.
          </p>
        </div>
      </section>
    );
  }

  const latestEpisodeIndex = snapshot.episodes.at(-1)?.index ?? 0;

  return (
    <section className="rounded-2xl border border-violet-500/25 bg-background/90 shadow-sm">
      <div className="border-b px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <GitBranchIcon className="h-4 w-4 text-violet-700" />
            <div>
              <h3 className="text-sm font-semibold">Evolution Session</h3>
              <p className="text-xs text-muted-foreground">
                {snapshot.episodes.length} episode{snapshot.episodes.length === 1 ? "" : "s"} · {snapshot.generations.length} persisted generation{snapshot.generations.length === 1 ? "" : "s"}.
              </p>
            </div>
          </div>
          <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${statusClasses[snapshot.status]}`}>
            {snapshot.status}
          </span>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        {snapshot.champion ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-700 dark:text-emerald-300">Global champion</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{snapshot.champion.candidateId}</p>
                <p className="text-xs text-muted-foreground">
                  {snapshot.champion.candidateKey} · {snapshot.champion.experimentId}
                </p>
              </div>
              <div className="text-right">
                <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">score</p>
                <p className="text-lg font-semibold text-foreground">{scoreLabel(snapshot.champion)}</p>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No champion has been selected yet.</p>
        )}

        {snapshot.episodes.map((episode) => (
          <details
            key={episode.episodeId}
            open={episode.index === latestEpisodeIndex}
            className="rounded-2xl border border-border/70 bg-muted/10"
          >
            <summary className="cursor-pointer px-3 py-3">
              <div className="inline-flex w-[calc(100%-1rem)] flex-wrap items-center justify-between gap-2 align-middle">
                <div>
                  <span className="text-sm font-semibold text-foreground">Episode {episode.index}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    g{episode.startGeneration}{episode.endGeneration && episode.endGeneration !== episode.startGeneration ? `–g${episode.endGeneration}` : ""}
                  </span>
                </div>
                <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${statusClasses[episode.status]}`}>
                  {episode.status}
                </span>
              </div>
            </summary>
            <div className="space-y-3 border-t px-3 py-3">
              <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
                <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-2">
                  <span className="font-medium text-foreground">Seed</span>
                  <div className="mt-1 break-all">{episode.seed.candidateKey}</div>
                </div>
                <div className="rounded-lg border border-border/60 bg-background/70 px-3 py-2">
                  <span className="font-medium text-foreground">Workspace</span>
                  <div className="mt-1 break-all">{episode.workspaceId ?? "unknown (migrated v1)"}</div>
                </div>
              </div>

              {episode.champion ? (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs">
                  <span className="font-medium text-emerald-700 dark:text-emerald-300">Episode champion</span>
                  <span className="ml-2 text-muted-foreground">
                    {episode.champion.candidateKey} · score {scoreLabel(episode.champion)}
                  </span>
                </div>
              ) : null}

              {episode.generations.map((generation) => (
                <GenerationDetails key={`${episode.episodeId}:${generation.generation}`} generation={generation} />
              ))}

              {episode.reason ? (
                <p className="rounded-xl border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
                  {episode.reason}
                </p>
              ) : null}
            </div>
          </details>
        ))}

        {snapshot.reason ? (
          <p className="rounded-xl border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs text-rose-700 dark:text-rose-300">
            Latest episode: {snapshot.reason}
          </p>
        ) : null}
      </div>
    </section>
  );
}
