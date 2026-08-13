"use client";

import React from "react";
import { useSession } from "next-auth/react";
import { Columns2, MessageSquareText, Workflow, X } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { ThreadTitleEditor } from "@/components/assistant-ui/thread-title";
import { ModelSelector } from "@/components/assistant-ui/model-selector";
import { LlmToggleButton } from "@/components/assistant-ui/llm-toggle";
import { useLlmEnabled } from "@/components/context/llm-enabled";
import { useSessionUiState, type SessionViewMode } from "@/components/context/session-ui-state";
import { EvolutionSessionSheet } from "@/components/workspace/evolution-session-sheet";
import { SessionContextSheet } from "@/components/workspace/session-context-sheet";
import { WorkspaceOnboardingDialog } from "@/components/workspace/workspace-onboarding-dialog";

export const AppHeader = () => {
  const { llmEnabled } = useLlmEnabled();
  const { data: session } = useSession();
  const { viewMode, setViewMode, toggleSplitView } = useSessionUiState();

  const viewOptions: Array<{
    icon: typeof MessageSquareText;
    label: string;
    value: SessionViewMode;
  }> = [
    { icon: MessageSquareText, label: "Chat", value: "chat" },
    { icon: Workflow, label: "Canvas", value: "canvas" },
    { icon: Columns2, label: "Split", value: "split" },
  ];

  const handleViewModeSelect = React.useCallback(
    (value: SessionViewMode) => {
      if (value === "split") {
        toggleSplitView();
        return;
      }
      setViewMode(value);
    },
    [setViewMode, toggleSplitView],
  );

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/80 bg-card/88 px-4 backdrop-blur-md">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mr-1 h-4 bg-border/80" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>
              <ThreadTitleEditor />
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-1 flex items-center rounded-[12px] border border-border/80 bg-muted/55 p-1">
        {viewOptions.map(({ icon: BaseIcon, label, value }) => {
          const isActive = viewMode === value;
          const isSplitOption = value === "split";
          const Icon = isSplitOption && isActive ? X : BaseIcon;
          const ariaLabel = isSplitOption
            ? isActive
              ? "Exit split workspace"
              : "Open split workspace"
            : `Show ${label.toLowerCase()} panel`;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={isActive}
              aria-label={ariaLabel}
              title={ariaLabel}
              className={`inline-flex items-center gap-1.5 rounded-[9px] px-3 py-1.5 text-[11px] font-medium transition ${
                isActive
                  ? "border border-border/80 bg-card text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                  : "text-muted-foreground hover:bg-card/70 hover:text-foreground"
              }`}
              onClick={() => handleViewModeSelect(value)}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <WorkspaceOnboardingDialog
          onOpenCanvas={() => setViewMode("split")}
          userId={session?.user?.id ?? null}
        />
        <ModelSelector />
        <EvolutionSessionSheet />
        <SessionContextSheet />
        <span
          className={`rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] ${
            llmEnabled
              ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
              : "border-amber-500/25 bg-amber-500/10 text-amber-200"
          }`}
        >
          {llmEnabled ? "AI on" : "AI off"}
        </span>
        <LlmToggleButton />
      </div>
    </header>
  );
};
