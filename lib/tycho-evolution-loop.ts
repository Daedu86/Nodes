export type TychoVariant<TSpec> = {
  id: string;
  spec: TSpec;
  metadata?: Record<string, unknown>;
};

export type EvolutionCandidate<TSpec> = TychoVariant<TSpec> & {
  generation: number;
  key: string;
  parentKey: string | null;
};

export type EvolutionEvaluation = {
  score: number;
  metrics?: Record<string, number>;
  evidence?: Record<string, unknown>;
};

/**
 * Generates the candidate population for one generation.
 *
 * Candidate generation is deliberately separate from experiment execution. In
 * the current Nodes/Tycho split, Luna/Codex can formulate hypotheses while the
 * Tycho harness executes and verifies them. A future optimizer can implement
 * this same contract without changing the evolution loop.
 */
export type EvolutionVariantGenerator<TSpec, TContext = undefined> = {
  generate: (input: {
    context: TContext;
    count: number;
    generation: number;
    parent: EvolutionCandidate<TSpec>;
  }) => Promise<readonly TychoVariant<TSpec>[]>;
};

/**
 * Backend-neutral execution boundary. The current Tycho experiment harness can
 * implement this contract locally; a later kagent/Kubernetes adapter can map
 * each candidate to an isolated job without changing selection semantics.
 */
export type EvolutionExecutionBackend<TSpec, TExecution, TContext = undefined> = {
  execute: (input: {
    candidate: EvolutionCandidate<TSpec>;
    context: TContext;
    generation: number;
    index: number;
  }) => Promise<TExecution>;
};

export type EvolutionEvaluator<TSpec, TExecution, TContext = undefined> = {
  evaluate: (input: {
    candidate: EvolutionCandidate<TSpec>;
    context: TContext;
    execution: TExecution;
    generation: number;
    index: number;
  }) => Promise<EvolutionEvaluation>;
};

export type EvolutionAttemptFailure = {
  message: string;
  stage: "execution" | "evaluation";
};

export type EvolutionAttempt<TSpec, TExecution> = {
  candidate: EvolutionCandidate<TSpec>;
  error: EvolutionAttemptFailure | null;
  evaluation: EvolutionEvaluation | null;
  execution: TExecution | null;
  index: number;
  status: "succeeded" | "failed";
};

export type EvolutionGeneration<TSpec, TExecution> = {
  attempts: EvolutionAttempt<TSpec, TExecution>[];
  error: string | null;
  generation: number;
  parent: EvolutionCandidate<TSpec>;
  requestedPopulation: number;
  status: "completed" | "failed";
  winner: EvolutionAttempt<TSpec, TExecution> | null;
};

export type EvolutionCompletedResult<TSpec, TExecution> = {
  finalWinner: EvolutionAttempt<TSpec, TExecution>;
  generations: EvolutionGeneration<TSpec, TExecution>[];
  seed: EvolutionCandidate<TSpec>;
  status: "completed";
};

export type EvolutionFailedResult<TSpec, TExecution> = {
  finalWinner: null;
  generations: EvolutionGeneration<TSpec, TExecution>[];
  reason: string;
  seed: EvolutionCandidate<TSpec>;
  status: "failed";
};

export type EvolutionResult<TSpec, TExecution> =
  | EvolutionCompletedResult<TSpec, TExecution>
  | EvolutionFailedResult<TSpec, TExecution>;

export type RunEvolutionLoopInput<TSpec, TExecution, TContext = undefined> = {
  context: TContext;
  evaluator: EvolutionEvaluator<TSpec, TExecution, TContext>;
  executionBackend: EvolutionExecutionBackend<TSpec, TExecution, TContext>;
  generations: number;
  populationSize: number;
  seed: TychoVariant<TSpec>;
  variantGenerator: EvolutionVariantGenerator<TSpec, TContext>;
};

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Unknown evolution error";
};

const buildCandidateKey = (generation: number, id: string) => `g${generation}:${id}`;

const normalizeVariantId = (id: string) => id.trim();

const validatePositiveInteger = (value: number, label: string) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
};

const selectWinner = <TSpec, TExecution>(
  attempts: EvolutionAttempt<TSpec, TExecution>[],
): EvolutionAttempt<TSpec, TExecution> | null => {
  const successful = attempts.filter(
    (attempt): attempt is EvolutionAttempt<TSpec, TExecution> & { evaluation: EvolutionEvaluation } =>
      attempt.status === "succeeded" && attempt.evaluation !== null,
  );

  if (successful.length === 0) return null;

  return [...successful].sort((a, b) => {
    const scoreDelta = b.evaluation.score - a.evaluation.score;
    if (scoreDelta !== 0) return scoreDelta;
    const indexDelta = a.index - b.index;
    if (indexDelta !== 0) return indexDelta;
    return a.candidate.key.localeCompare(b.candidate.key);
  })[0] ?? null;
};

const runCandidate = async <TSpec, TExecution, TContext>(
  candidate: EvolutionCandidate<TSpec>,
  index: number,
  generation: number,
  context: TContext,
  executionBackend: EvolutionExecutionBackend<TSpec, TExecution, TContext>,
  evaluator: EvolutionEvaluator<TSpec, TExecution, TContext>,
): Promise<EvolutionAttempt<TSpec, TExecution>> => {
  let execution: TExecution;
  try {
    execution = await executionBackend.execute({ candidate, context, generation, index });
  } catch (error) {
    return {
      candidate,
      error: { message: toErrorMessage(error), stage: "execution" },
      evaluation: null,
      execution: null,
      index,
      status: "failed",
    };
  }

  try {
    const evaluation = await evaluator.evaluate({
      candidate,
      context,
      execution,
      generation,
      index,
    });
    if (!Number.isFinite(evaluation.score)) {
      throw new Error("Evaluator score must be a finite number.");
    }
    return {
      candidate,
      error: null,
      evaluation,
      execution,
      index,
      status: "succeeded",
    };
  } catch (error) {
    return {
      candidate,
      error: { message: toErrorMessage(error), stage: "evaluation" },
      evaluation: null,
      execution,
      index,
      status: "failed",
    };
  }
};

export async function runEvolutionLoop<TSpec, TExecution, TContext = undefined>(
  input: RunEvolutionLoopInput<TSpec, TExecution, TContext>,
): Promise<EvolutionResult<TSpec, TExecution>> {
  validatePositiveInteger(input.generations, "generations");
  validatePositiveInteger(input.populationSize, "populationSize");

  const seedId = normalizeVariantId(input.seed.id);
  if (!seedId) throw new Error("seed.id must not be empty.");

  const seed: EvolutionCandidate<TSpec> = {
    ...input.seed,
    id: seedId,
    generation: 0,
    key: buildCandidateKey(0, seedId),
    parentKey: null,
  };
  const generations: EvolutionGeneration<TSpec, TExecution>[] = [];
  let parent = seed;
  let latestWinner: EvolutionAttempt<TSpec, TExecution> | null = null;

  for (let generation = 1; generation <= input.generations; generation += 1) {
    let variants: readonly TychoVariant<TSpec>[];
    try {
      variants = await input.variantGenerator.generate({
        context: input.context,
        count: input.populationSize,
        generation,
        parent,
      });
    } catch (error) {
      const reason = `Generation ${generation} variant generation failed: ${toErrorMessage(error)}`;
      generations.push({
        attempts: [],
        error: reason,
        generation,
        parent,
        requestedPopulation: input.populationSize,
        status: "failed",
        winner: null,
      });
      return { finalWinner: null, generations, reason, seed, status: "failed" };
    }

    if (variants.length === 0) {
      const reason = `Generation ${generation} produced no variants.`;
      generations.push({
        attempts: [],
        error: reason,
        generation,
        parent,
        requestedPopulation: input.populationSize,
        status: "failed",
        winner: null,
      });
      return { finalWinner: null, generations, reason, seed, status: "failed" };
    }

    if (variants.length > input.populationSize) {
      const reason = `Generation ${generation} produced ${variants.length} variants, exceeding populationSize ${input.populationSize}.`;
      generations.push({
        attempts: [],
        error: reason,
        generation,
        parent,
        requestedPopulation: input.populationSize,
        status: "failed",
        winner: null,
      });
      return { finalWinner: null, generations, reason, seed, status: "failed" };
    }

    const ids = variants.map((variant) => normalizeVariantId(variant.id));
    const invalidId = ids.findIndex((id) => !id);
    const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (invalidId >= 0 || duplicateIds.length > 0) {
      const reason = invalidId >= 0
        ? `Generation ${generation} contains a variant with an empty id.`
        : `Generation ${generation} contains duplicate variant ids: ${[...new Set(duplicateIds)].join(", ")}.`;
      generations.push({
        attempts: [],
        error: reason,
        generation,
        parent,
        requestedPopulation: input.populationSize,
        status: "failed",
        winner: null,
      });
      return { finalWinner: null, generations, reason, seed, status: "failed" };
    }

    const candidates = variants.map<EvolutionCandidate<TSpec>>((variant, index) => ({
      ...variant,
      id: ids[index] ?? variant.id,
      generation,
      key: buildCandidateKey(generation, ids[index] ?? variant.id),
      parentKey: parent.key,
    }));

    const attempts = await Promise.all(
      candidates.map((candidate, index) =>
        runCandidate(
          candidate,
          index,
          generation,
          input.context,
          input.executionBackend,
          input.evaluator,
        ),
      ),
    );
    const winner = selectWinner(attempts);

    if (!winner) {
      const reason = `Generation ${generation} has no successfully evaluated candidates.`;
      generations.push({
        attempts,
        error: reason,
        generation,
        parent,
        requestedPopulation: input.populationSize,
        status: "failed",
        winner: null,
      });
      return { finalWinner: null, generations, reason, seed, status: "failed" };
    }

    generations.push({
      attempts,
      error: null,
      generation,
      parent,
      requestedPopulation: input.populationSize,
      status: "completed",
      winner,
    });
    latestWinner = winner;
    parent = winner.candidate;
  }

  if (!latestWinner) {
    throw new Error("Evolution loop completed without a winner.");
  }

  return {
    finalWinner: latestWinner,
    generations,
    seed,
    status: "completed",
  };
}
