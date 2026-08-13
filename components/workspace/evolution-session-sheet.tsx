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
import { EvolutionSessionPanel } from "@/components/workspace/evolution-session-panel";
import { getEvolutionSessionArtifact } from "@/lib/tycho/evolution-session-snapshot";

export function EvolutionSessionSheet() {
  const { artifacts } = useSessionArtifacts();
  if (!getEvolutionSessionArtifact(artifacts)) return null;

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          aria-label="Open evolution history"
          title="Open evolution history"
        >
          <GitBranchIcon className="h-4 w-4" />
          <span className="hidden 2xl:inline">Evolution</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[94vw] gap-0 sm:max-w-3xl">
        <SheetHeader className="border-b pb-4">
          <SheetTitle>Evolution History</SheetTitle>
          <SheetDescription>
            Inspect persisted candidate runs, Tycho decisions, scores, evidence, lineage, and the current champion for this Session.
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-4 py-4">
          <EvolutionSessionPanel artifacts={artifacts} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
