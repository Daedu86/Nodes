import type { CodexCanvasEvent, CodexCanvasEventType } from "@/lib/agents/codex/types";
import type {
  AgentRuntimeEventDraft,
  AgentRuntimeEventType,
} from "@/lib/agents/runtime/types";

const eventTypeByCodexType: Record<CodexCanvasEventType, AgentRuntimeEventType> = {
  "agent.started": "agent.started",
  "agent.message.delta": "agent.message.delta",
  "agent.message.completed": "agent.message.completed",
  "agent.child.spawned": "agent.child.spawned",
  "tool.started": "tool.started",
  "tool.completed": "tool.completed",
  "shell.started": "shell.started",
  "shell.completed": "shell.completed",
  "file.changed": "file.changed",
  "approval.requested": "approval.requested",
  "approval.resolved": "approval.resolved",
  "run.completed": "run.completed",
  "run.failed": "run.failed",
  "run.cancelled": "run.cancelled",
  unknown: "runtime.unknown",
};

/**
 * Preserve the existing Codex event payload while placing it in the common
 * runtime envelope. A NOOA adapter can emit the same event vocabulary later.
 */
export function codexEventToRuntimeEvent(
  event: CodexCanvasEvent,
  nodeId: string,
): AgentRuntimeEventDraft {
  return {
    id: event.id,
    runId: event.runId,
    nodeId,
    runtime: "codex",
    type: eventTypeByCodexType[event.type],
    source: "runtime",
    createdAt: event.createdAt,
    parentRunId: event.parentRunId ?? null,
    payload: event.payload,
  };
}
