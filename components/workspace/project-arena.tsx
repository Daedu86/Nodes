"use client";

import React from "react";
import { ArrowUpRight, CopyPlus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectArenaExperimentPanel } from "@/components/workspace/project-arena-experiment-panel";
import type { ProjectArenaEntry, ProjectArenaEntryKind, ProjectArenaSummary } from "@/lib/project-arena";

const formatUpdatedAt = (value: string) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
};

const StatPill = ({ label, value }: { label: string; value: string | number }) => (
  <span className="rounded-full border border-border/60 bg-background/80 px-2 py-1 text-[11px] text-muted-foreground">
    <span className="font-medium text-foreground">{value}</span> {label}
  </span>
);

export function ProjectArena({
  canEdit,
  canManageTypedNodes,
  canOpenSessions,
  compareMode,
  entries,
  summary,
  onOpenSession,
  onAppendSummary,
  onCreateMergeNode,
  onPromoteLead,
  onSaveSummaryToMemory,
  winnerKey,
}: {
  canEdit: boolean;
  canManageTypedNodes: boolean;
  canOpenSessions: boolean;
  compareMode: ProjectArenaEntryKind;
  entries: ProjectArenaEntry[];
  summary: ProjectArenaSummary | null;
  onAppendSummary: () => void;
  onCreateMergeNode: () => void;
  onOpenSession: (sessionId: string) => void;
  onPromoteLead: () => void;
  onSaveSummaryToMemory: () => void;
  winnerKey: string | null;
}) {
  if (entries.length < 2) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-xl rounded-3xl border border-dashed border-border/70 bg-background/80 px-6 py-8 text-center shadow-sm">
          <p className="text-base font-semibold text-foreground">Project Arena needs at least two {compareMode === "session" ? "sessions" : "branches"}.</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Pick 2-4 {compareMode === "session" ? "member sessions" : "root branches"} from the left panel and open Arena to compare them side by side.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-b border-border/60 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Project Arena</p>
            <p className="text-xs text-muted-foreground">
              Compare {entries.length} {compareMode === "session" ? "sessions" : "branches"} side by side and promote a lead direction into global context.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onAppendSummary} disabled={!canEdit || !summary}>
              <CopyPlus className="h-3.5 w-3.5" />
              Merge into context
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onCreateMergeNode} disabled={!canManageTypedNodes || !summary}>
              <Sparkles className="h-3.5 w-3.5" />
              Create merge node
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onSaveSummaryToMemory} disabled={!canManageTypedNodes || !summary}>
              <Sparkles className="h-3.5 w-3.5" />
              Save as memory
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {entries.map((entry) => {
              const isLead = summary?.leadKey === entry.key;
              const isFreshest = summary?.freshestKey === entry.key;
              const isWinner = winnerKey === entry.key;

              return (
                <section
                  key={entry.key}
                  className={`rounded-3xl border bg-background/90 px-4 py-4 shadow-sm ${
                    isLead
                      ? "border-sky-500/35 bg-sky-500/5"
                      : "border-border/60"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-base font-semibold text-foreground">{entry.title}</p>
                        {isLead ? (
                          <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-sky-700">
                            Lead candidate
                          </span>
                        ) : null}
                        {isFreshest ? (
                          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-emerald-700">
                            Freshest
                          </span>
                        ) : null}
                        {isWinner ? (
                          <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-amber-700">
                            Winner
                          </span>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">Updated {formatUpdatedAt(entry.updatedAt)}</p>
                      <p className="text-xs text-muted-foreground">{entry.descriptor}</p>
                    </div>
                    <Button type="button" variant="outline" size="sm" disabled={!canOpenSessions} onClick={() => onOpenSession(entry.sessionId)}>
                      <ArrowUpRight className="h-3.5 w-3.5" />
                      Open
                    </Button>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <StatPill label="messages" value={entry.messageCount} />
                    <StatPill label="branches" value={entry.branchGroups} />
                    <StatPill label="artifacts" value={entry.artifactCount} />
                    <StatPill label="tokens" value={entry.estimatedTokens} />
                    {entry.kind === "session" ? <StatPill label="roots" value={entry.rootCount} /> : null}
                  </div>
                  {entry.artifactTitles.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {entry.artifactTitles.map((artifactTitle) => (
                        <span
                          key={`${entry.key}:${artifactTitle}`}
                          className="rounded-full border border-violet-500/25 bg-violet-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-violet-700"
                        >
                          {artifactTitle}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-4 space-y-3">
                    <div className="rounded-2xl border border-border/60 bg-muted/25 px-3 py-3">
                      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                        Opening prompt
                      </p>
                      <p className="mt-2 text-sm leading-6 text-foreground/90">{entry.openingPrompt}</p>
                    </div>
                    <div className="rounded-2xl border border-border/60 bg-muted/25 px-3 py-3">
                      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                        Latest assistant signal
                      </p>
                      <p className="mt-2 text-sm leading-6 text-foreground/90">{entry.latestAssistant}</p>
                    </div>
                    <div className="rounded-2xl border border-border/60 bg-muted/25 px-3 py-3">
                      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                        Latest user prompt
                      </p>
                      <p className="mt-2 text-sm leading-6 text-foreground/90">{entry.latestUser}</p>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>

          <aside className="space-y-4">
            <ProjectArenaExperimentPanel />
            <section className="rounded-3xl border border-border/60 bg-background/90 px-4 py-4 shadow-sm">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-700" />
                <div>
                  <p className="text-sm font-semibold text-foreground">Arena Synthesis</p>
                  <p className="text-xs text-muted-foreground">
                    Heuristic synthesis from the compared sessions.
                  </p>
                </div>
              </div>
              {summary ? (
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl border border-sky-500/30 bg-sky-500/10 px-3 py-3">
                    <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-sky-700">
                      Lead candidate
                    </p>
                    <p className="mt-2 text-sm font-semibold text-foreground">
                      {entries.find((entry) => entry.key === summary.leadKey)?.title ?? "Unknown candidate"}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-foreground/90">{summary.leadReason}</p>
                    <Button type="button" variant="outline" size="sm" className="mt-3" disabled={!canEdit} onClick={onPromoteLead}>
                      <Sparkles className="h-3.5 w-3.5" />
                      Pick winner
                    </Button>
                  </div>
                  <div className="rounded-2xl border border-border/60 bg-muted/25 px-3 py-3">
                    <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                      Summary
                    </p>
                    <p className="mt-2 text-sm leading-6 text-foreground/90">{summary.summary}</p>
                  </div>
                  <div className="rounded-2xl border border-border/60 bg-muted/25 px-3 py-3">
                    <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                      Project note preview
                    </p>
                    <pre className="mt-2 whitespace-pre-wrap text-xs leading-6 text-foreground/85">
                      {summary.note}
                    </pre>
                  </div>
                  {summary.sharedMemoryTitles.length > 0 ? (
                    <div className="rounded-2xl border border-border/60 bg-muted/25 px-3 py-3">
                      <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                        Reusable memory in scope
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {summary.sharedMemoryTitles.map((title) => (
                          <span
                            key={title}
                            className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-emerald-700"
                          >
                            {title}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted-foreground">
                  Pick more sessions to generate a synthesis.
                </p>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
