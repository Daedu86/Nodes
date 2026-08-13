import "server-only";

import {
  cancelCodexRun,
  startCodexRun,
  streamCodexRunEvents,
} from "@/lib/agents/codex/runner-client";
import type {
  CodexRunnerStartRequest,
  CodexRunnerStartResponse,
} from "@/lib/agents/codex/types";
import type { EvolutionVariantGenerator } from "@/lib/tycho-evolution-loop";
import {
  buildCodexEvolutionVariantPrompt,
  parseCodexEvolutionVariantOutput,
} from "@/lib/tycho/codex-evolution-variant-contract";
import { consumeCodexGeneratorStream } from "@/lib/tycho/codex-evolution-run-output";
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

const finitePositiveInteger = (value: number, fallback: number, label: string) => {
  const resolved = Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (resolved <= 0) throw new Error(`${label} must be a positive finite integer.`);
  return resolved;
};

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
        const output = await consumeCodexGeneratorStream({
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
