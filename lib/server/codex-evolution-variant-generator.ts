import "server-only";

import { normalizeCodexNotification } from "@/lib/agents/codex/event-mapper";
import {
  cancelCodexRun,
  startCodexRun,
  streamCodexRunEvents,
} from "@/lib/agents/codex/runner-client";
import type {
  CodexCanvasEvent,
  CodexRunnerEventEnvelope,
  CodexRunnerStartRequest,
  CodexRunnerStartResponse,
} from "@/lib/agents/codex/types";
import type { EvolutionVariantGenerator } from "@/lib/tycho-evolution-loop";
import {
  buildCodexEvolutionVariantPrompt,
  parseCodexEvolutionVariantOutput,
} from "@/lib/tycho/codex-evolution-variant-contract";
import type {
  TychoEvolutionContext,
  TychoEvolutionSpec,
} from "@/lib/tycho/evolution-backend";

export {
  buildCodexEvolutionVariantPrompt,
  parseCodexEvolutionVariantOutput,
} from "@/lib/tycho/codex-evolution-variant-contract";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;

export type CodexEvolutionVariantGeneratorOptions = {
  label?: string;
  maxOutputChars?: number;
  timeoutMs?: number;
};

type GeneratorDependencies = {
  cancel: (ownerId: string, runId: string) => Promise<unknown>;
  start: (input: CodexRunnerStartRequest) => Promise<CodexRunnerStartResponse>;
  stream: (ownerId: string, runId: string, afterEventId?: string | null) => Promise<Response>;
};

const defaultDependencies: GeneratorDependencies = {
  cancel: cancelCodexRun,
  start: startCodexRun,
  stream: streamCodexRunEvents,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finitePositiveInteger = (value: number, fallback: number, label: string) => {
  const resolved = Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (resolved <= 0) throw new Error(`${label} must be a positive finite integer.`);
  return resolved;
};

const parseSseData = (frame: string) => {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  return data && data !== "[DONE]" ? data : null;
};

const parseEnvelope = (data: string): CodexRunnerEventEnvelope => {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error("Codex runner emitted malformed SSE JSON.");
  }
  if (!isRecord(value) || !isRecord(value.notification) || typeof value.notification.method !== "string") {
    throw new Error("Codex runner emitted an invalid event envelope.");
  }
  return value as CodexRunnerEventEnvelope;
};

const completedMessageText = (event: CodexCanvasEvent) => {
  if (event.type !== "agent.message.completed") return null;
  const params = isRecord(event.payload.params) ? event.payload.params : {};
  return typeof params.text === "string" && params.text.trim() ? params.text.trim() : null;
};

class GeneratorApprovalRequiredError extends Error {}
class GeneratorTimeoutError extends Error {}

async function consumeGeneratorStream(input: {
  response: Response;
  runId: string;
  timeoutMs: number;
  maxOutputChars: number;
}) {
  if (!input.response.ok || !input.response.body) {
    const message = await input.response.text().catch(() => "Codex event stream unavailable.");
    throw new Error(message || `Codex event stream unavailable: ${input.response.status}`);
  }

  const reader = input.response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + input.timeoutMs;
  let buffer = "";
  let latestCompletedMessage: string | null = null;
  let terminal = false;

  const readWithDeadline = async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GeneratorTimeoutError("Codex variant generation timed out.");
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new GeneratorTimeoutError("Codex variant generation timed out.")),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const handleFrame = (frame: string) => {
    const data = parseSseData(frame);
    if (!data) return;
    const envelope = parseEnvelope(data);
    const event = normalizeCodexNotification({
      notification: envelope.notification,
      runId: input.runId,
      eventId: envelope.id,
      createdAt: envelope.createdAt,
      threadId: envelope.threadId,
      parentRunId: envelope.parentRunId,
      agentId: envelope.agentId,
    });

    if (event.type === "approval.requested") {
      throw new GeneratorApprovalRequiredError(
        "Codex variant generator requested an approval; hypothesis generation must be side-effect free.",
      );
    }
    if (event.type === "run.failed") throw new Error("Codex variant generation run failed.");
    if (event.type === "run.cancelled") throw new Error("Codex variant generation run was cancelled.");

    const text = completedMessageText(event);
    if (text) {
      if (text.length > input.maxOutputChars) {
        throw new Error(`Codex variant generator output exceeds ${input.maxOutputChars} characters.`);
      }
      latestCompletedMessage = text;
    }
    if (event.type === "run.completed") terminal = true;
  };

  try {
    while (!terminal) {
      const chunk = await readWithDeadline();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        handleFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleFrame(buffer);
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (!terminal) throw new Error("Codex variant generation stream ended before run completion.");
  if (!latestCompletedMessage) {
    throw new Error("Codex variant generation completed without a final agent message.");
  }
  return latestCompletedMessage;
}

export function createCodexEvolutionVariantGenerator(
  options: CodexEvolutionVariantGeneratorOptions = {},
  dependencies: GeneratorDependencies = defaultDependencies,
): EvolutionVariantGenerator<TychoEvolutionSpec, TychoEvolutionContext> {
  const timeoutMs = finitePositiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "timeoutMs",
  );
  const maxOutputChars = finitePositiveInteger(
    options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
    DEFAULT_MAX_OUTPUT_CHARS,
    "maxOutputChars",
  );
  const label = options.label?.trim() || "Tycho evolution hypothesis generator";

  return {
    generate: async ({ context, count, generation, parent, parentEvaluation }) => {
      const sessionId = context.sessionId?.trim();
      if (!sessionId) {
        throw new Error("Codex evolution variant generation requires context.sessionId.");
      }

      const started = await dependencies.start({
        ownerId: context.ownerId,
        sessionId,
        projectId: context.projectId ?? null,
        workspaceId: context.workspaceId,
        prompt: buildCodexEvolutionVariantPrompt({
          count,
          generation,
          parent,
          parentEvaluation,
        }),
        role: "researcher",
        label,
        approvalMode: "interactive",
        workspaceFiles: [],
        metadata: {
          purpose: "tycho-evolution-variant-generation",
          generation,
          parentKey: parent.key,
          requestedPopulation: count,
        },
      });

      if (started.status === "waiting_for_approval") {
        await dependencies.cancel(context.ownerId, started.runId).catch(() => undefined);
        throw new Error("Codex variant generator entered approval state before streaming output.");
      }
      if (started.status === "failed" || started.status === "cancelled") {
        throw new Error(`Codex variant generator could not start: ${started.status}.`);
      }

      try {
        const response = await dependencies.stream(context.ownerId, started.runId);
        const output = await consumeGeneratorStream({
          response,
          runId: started.runId,
          timeoutMs,
          maxOutputChars,
        });
        return parseCodexEvolutionVariantOutput(output, count);
      } catch (error) {
        await dependencies.cancel(context.ownerId, started.runId).catch(() => undefined);
        throw error;
      }
    },
  };
}
