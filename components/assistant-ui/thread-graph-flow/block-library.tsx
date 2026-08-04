"use client";

import {
  Bot,
  Braces,
  FileText,
  GitBranch,
  ImageIcon,
  ListChecks,
  MessageSquareText,
  Plus,
  Scale,
  Table2,
  TextCursorInput,
  Upload,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  SessionArtifactSemanticType,
  SessionArtifactType,
} from "@/lib/session-artifacts";

export const CANVAS_BLOCK_DRAG_MIME = "application/x-nodes-canvas-block";

export type CanvasBlockDefinition = {
  id: string;
  category: "process" | "inputs" | "outputs";
  title: string;
  description: string;
  artifactType?: SessionArtifactType;
  semanticType?: SessionArtifactSemanticType | null;
  action: "root" | "prompt" | "artifact" | "upload-file" | "upload-image";
  accent: string;
  icon: LucideIcon;
};

export const INITIAL_CANVAS_BLOCKS: CanvasBlockDefinition[] = [
  {
    id: "process-conversation-root",
    category: "process",
    title: "Conversation Root",
    description: "Optional starting point for a conversation tree.",
    action: "root",
    accent: "#0284c7",
    icon: GitBranch,
  },
  {
    id: "process-prompt",
    category: "process",
    title: "Prompt",
    description: "Run a model instruction with connected inputs and outputs.",
    action: "prompt",
    accent: "#0f766e",
    icon: MessageSquareText,
  },
  {
    id: "input-text",
    category: "inputs",
    title: "Text",
    description: "Reusable narrative context.",
    action: "artifact",
    artifactType: "text",
    semanticType: null,
    accent: "#64748b",
    icon: TextCursorInput,
  },
  {
    id: "input-file",
    category: "inputs",
    title: "File",
    description: "Upload a source file and extracted text.",
    action: "upload-file",
    artifactType: "file",
    semanticType: null,
    accent: "#2563eb",
    icon: Upload,
  },
  {
    id: "input-image",
    category: "inputs",
    title: "Image",
    description: "Visual context with an optional note.",
    action: "upload-image",
    artifactType: "image",
    semanticType: null,
    accent: "#db2777",
    icon: ImageIcon,
  },
  {
    id: "input-code",
    category: "inputs",
    title: "Code",
    description: "Exact syntax, config, or implementation context.",
    action: "artifact",
    artifactType: "code",
    semanticType: null,
    accent: "#059669",
    icon: Braces,
  },
  {
    id: "output-decision",
    category: "outputs",
    title: "Decision",
    description: "Recommendation, rationale, risks, and alternatives.",
    action: "artifact",
    artifactType: "text",
    semanticType: "decision",
    accent: "#7c3aed",
    icon: Scale,
  },
  {
    id: "output-evidence",
    category: "outputs",
    title: "Evidence",
    description: "Claims, observations, sources, and relevance.",
    action: "artifact",
    artifactType: "text",
    semanticType: "evidence",
    accent: "#2563eb",
    icon: FileText,
  },
  {
    id: "output-plan",
    category: "outputs",
    title: "Plan",
    description: "Ordered steps, dependencies, and verification.",
    action: "artifact",
    artifactType: "text",
    semanticType: "plan",
    accent: "#ea580c",
    icon: ListChecks,
  },
  {
    id: "output-table",
    category: "outputs",
    title: "Table",
    description: "Deterministic rows and columns with text fallback.",
    action: "artifact",
    artifactType: "text",
    semanticType: "table",
    accent: "#0891b2",
    icon: Table2,
  },
];

const categoryLabels: Record<CanvasBlockDefinition["category"], string> = {
  process: "Process",
  inputs: "Input",
  outputs: "Output",
};

export function getCanvasBlockDefinition(id: string) {
  return INITIAL_CANVAS_BLOCKS.find((block) => block.id === id) ?? null;
}

export function CanvasBlockLibrary({
  onAddAgent,
  onAddBlock,
}: {
  collapsed: boolean;
  onAddAgent: () => void;
  onAddBlock: (block: CanvasBlockDefinition) => void;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  return (
    <aside
      aria-label="Block library"
      data-testid="canvas-block-library"
      className="relative z-30 flex h-full w-14 shrink-0 flex-col border-r border-border/60 bg-transparent"
    >
      <div className="flex flex-1 flex-col items-center gap-2 overflow-y-auto py-3">
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                title="Add a Codex agent to run an independent task on the canvas."
                aria-label="Add Codex agent to canvas"
                className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/30 bg-sky-500/10 text-sky-700 transition hover:bg-sky-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-sky-200"
                onClick={onAddAgent}
              >
                <Bot className="h-4 w-4" />
                <Plus className="absolute bottom-1.5 right-1.5 h-2.5 w-2.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              Add a Codex agent to run an independent task.
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>

        <div className="h-px w-8 shrink-0 bg-border/60" aria-hidden="true" />

        {INITIAL_CANVAS_BLOCKS.map((block) => {
          const Icon = block.icon;
          const helpText = `${categoryLabels[block.category]}: ${block.title} — ${block.description} Click to add or drag onto the canvas.`;

          return (
            <button
              key={block.id}
              type="button"
              draggable
              title={helpText}
              aria-label={`Add ${block.title} block. ${block.description}`}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onAddBlock(block)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "copy";
                event.dataTransfer.setData(CANVAS_BLOCK_DRAG_MIME, block.id);
                event.dataTransfer.setData("text/plain", block.id);
              }}
            >
              <Icon className="h-4 w-4" style={{ color: block.accent }} />
            </button>
          );
        })}
      </div>
    </aside>
  );
}
