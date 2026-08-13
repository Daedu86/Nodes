"use client";

import { GitBranchIcon } from "lucide-react";
import { useSessionArtifacts } from "@/components/context/session-artifacts";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { EvolutionRunControl } from "@/components/workspace/evolution-run-control";
import { EvolutionSessionPanel } from "@/components/workspace/evolution-session-panel";
import { getEvolutionSessionArtifact } from "@/lib/tycho/evolution-session-snapshot";

export function EvolutionSessionSheet() {
  const { artifacts } = useSessionArtifacts();
  const hasHistory = Boolean(getEvolutionSessionArtifact(artifacts));

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          aria-label="Open evolution control"
          title="Open evolution control"
        >
          <GitBranchIcon className="h-4 w-4" />
          <span className="hidden 2xl:inline">Evolution</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[94vw] gap-0 sm:max-w-3xl">
        <SheetHeader className="border-b pb-4">
          <SheetTitle>Evolution</SheetTitle>
          <SheetDescription>
            Configure an adaptive Codex → Tycho experiment run and inspect persisted candidate evidence, lineage, scores, and the champion.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <EvolutionRunControl />
          {hasHistory ? <EvolutionSessionPanel artifacts={artifacts} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
