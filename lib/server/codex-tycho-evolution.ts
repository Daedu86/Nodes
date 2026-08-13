import "server-only";

import {
  createCodexEvolutionVariantGenerator,
  type CodexEvolutionVariantGeneratorOptions,
} from "@/lib/server/codex-evolution-variant-generator";
import {
  runPersistedTychoEvolution,
  type RunPersistedTychoEvolutionInput,
} from "@/lib/server/tycho-evolution-session";

export type RunCodexTychoEvolutionInput = Omit<
  RunPersistedTychoEvolutionInput,
  "variantGenerator"
> & {
  generatorOptions?: CodexEvolutionVariantGeneratorOptions;
};

/**
 * Runs the complete local adaptive loop:
 * Codex proposes variants from the current champion + reward, Tycho executes
 * and evaluates them, the loop promotes a winner, and Session persistence
 * records every terminal generation for Canvas inspection.
 */
export async function runCodexTychoEvolution(input: RunCodexTychoEvolutionInput) {
  const { generatorOptions, ...evolutionInput } = input;
  return runPersistedTychoEvolution({
    ...evolutionInput,
    variantGenerator: createCodexEvolutionVariantGenerator(generatorOptions),
  });
}
