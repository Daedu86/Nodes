import type {
  AgentPromptSection,
  AgentRequestAssembly,
} from "@/lib/agents/kernel/request-assembly";
import { getAgentRequestAssembler } from "@/lib/agents/runtime/kernel";
import {
  createAgentSessionJournal,
  type DurableAgentSessionJournal,
} from "@/lib/server/agent-session-journal";

export type PrepareAgentRuntimeRequestInput = {
  runtime: string;
  ownerId: string;
  sessionId: string;
  projectId?: string | null;
  role?: string | null;
  prompt: string;
  model?: string | null;
  reasoningEffort?: string | null;
  approvalMode?: string | null;
  sandboxPolicyId?: string | null;
  contextWindow?: number | null;
  workspacePaths?: readonly string[];
  toolNames?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
  eventIngestion?: "stream" | "callback";
  sections?: readonly AgentPromptSection[];
};

export type PreparedAgentRuntimeRequest = {
  assembly: AgentRequestAssembly;
  journal: DurableAgentSessionJournal;
};

/**
 * Assemble the effective model request and durably checkpoint the exact request
 * envelope before provider dispatch. If this initial checkpoint cannot be
 * persisted, the provider is not started: a run that cannot be reconstructed
 * must not be presented as reproducible work.
 */
export async function prepareAgentRuntimeRequest(
  input: PrepareAgentRuntimeRequestInput,
): Promise<PreparedAgentRuntimeRequest> {
  const assembly = getAgentRequestAssembler().assemble({
    runtime: input.runtime,
    sessionId: input.sessionId,
    projectId: input.projectId,
    role: input.role,
    prompt: input.prompt,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    approvalMode: input.approvalMode,
    sandboxPolicyId: input.sandboxPolicyId,
    contextWindow: input.contextWindow,
    workspacePaths: input.workspacePaths,
    toolNames: input.toolNames,
    metadata: input.metadata,
    sections: input.sections,
  });
  const journal = createAgentSessionJournal({
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    projectId: input.projectId,
  });

  journal.log.append("request.snapshot", {
    assemblyId: assembly.header.assemblyId,
    runtime: assembly.header.runtime,
    provider: assembly.header.runtime,
    model: assembly.header.model ?? undefined,
    reasoningEffort: assembly.header.reasoningEffort ?? undefined,
    systemPrompt: assembly.systemPrompt || undefined,
    tools: assembly.header.toolNames.length ? assembly.header.toolNames : undefined,
    contextWindow: assembly.header.contextWindow ?? undefined,
    approvalMode: assembly.header.approvalMode ?? undefined,
    sandboxPolicyId: assembly.header.sandboxPolicyId ?? undefined,
    workspacePaths: assembly.header.workspacePaths.length
      ? assembly.header.workspacePaths
      : undefined,
    sectionNames: assembly.header.sectionNames.length
      ? assembly.header.sectionNames
      : undefined,
  });
  journal.log.appendSurface("user.message", {
    messageId: `${assembly.header.assemblyId}:user`,
    content: input.prompt,
    source: "human",
  });
  journal.log.append("runtime.run", {
    runtime: assembly.header.runtime,
    status: "requested",
    runId: null,
    eventIngestion: input.eventIngestion,
  });
  await journal.flush();

  return { assembly, journal };
}

export async function recordAgentRuntimeStartSuccess(
  journal: DurableAgentSessionJournal,
  input: {
    runtime: string;
    runId: string;
    providerRunId?: string | null;
  },
): Promise<void> {
  journal.log.append("runtime.run", {
    runtime: input.runtime,
    status: "started",
    runId: input.runId,
    providerRunId: input.providerRunId ?? null,
  });
  try {
    await journal.flush();
  } catch (error) {
    console.warn("[agent-kernel] failed to persist started runtime binding", error);
  }
}

export async function recordAgentRuntimeStartFailure(
  journal: DurableAgentSessionJournal,
  input: { runtime: string; message: string },
): Promise<void> {
  journal.log.append("runtime.run", {
    runtime: input.runtime,
    status: "failed",
    runId: null,
    message: input.message,
  });
  try {
    await journal.flush();
  } catch (error) {
    console.warn("[agent-kernel] failed to persist runtime start failure", error);
  }
}
