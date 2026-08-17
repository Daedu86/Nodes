import {
  collectAgentRunMetrics,
  type AgentRunMetrics,
} from "@/lib/agents/kernel/observability";
import type { AgentRuntimeId } from "@/lib/agents/runtime/types";
import type { AgentWorkRepository } from "@/lib/persistence/agent-work-repository";
import { findAgentSessionJournalForRun } from "@/lib/server/agent-session-journal";
import { AgentRunNotFoundError } from "@/lib/agents/runtime/run-status";

export type AgentRunMetricsSnapshot = AgentRunMetrics & {
  runtime: AgentRuntimeId;
  runId: string;
  journalId: string;
};

export async function getAgentRunMetrics(input: {
  ownerId: string;
  runtime: AgentRuntimeId;
  runId: string;
  repository?: AgentWorkRepository;
}): Promise<AgentRunMetricsSnapshot> {
  const ownerId = input.ownerId.trim();
  const runId = input.runId.trim();
  if (!ownerId) throw new Error("Agent run ownerId must not be empty.");
  if (!runId) throw new Error("Agent run runId must not be empty.");
  const journal = await findAgentSessionJournalForRun({
    ownerId,
    runtime: input.runtime,
    runId,
    repository: input.repository,
  });
  if (!journal) throw new AgentRunNotFoundError(input.runtime, runId);
  return {
    runtime: input.runtime,
    runId,
    journalId: journal.identity.journalId,
    ...collectAgentRunMetrics(journal.log.events()),
  };
}
