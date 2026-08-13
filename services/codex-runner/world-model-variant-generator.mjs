const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));

function modeOf(value) {
  const mode = String(value || process.env.TYCHO_WORLD_MODEL_MODE || "off").trim().toLowerCase();
  if (!["off", "observe", "online"].includes(mode)) throw new Error("TYCHO_WORLD_MODEL_MODE must be off, observe, or online.");
  return mode;
}

function annotate(variant, prediction, extra = {}) {
  return {
    ...variant,
    metadata: {
      ...(isRecord(variant.metadata) ? variant.metadata : {}),
      worldModelPrediction: {
        ...prediction,
        ...extra,
      },
    },
  };
}

export function createWorldModelVariantGenerator(options = {}) {
  if (typeof options.baseGenerator !== "function") throw new Error("World-model generator requires baseGenerator.");
  if (!options.worldModel || typeof options.worldModel.predictBatch !== "function") throw new Error("World-model generator requires worldModel.");
  const baseGenerator = options.baseGenerator;
  const worldModel = options.worldModel;
  const mode = modeOf(options.mode);
  const expansionFactor = clamp(options.expansionFactor ?? process.env.TYCHO_WORLD_MODEL_EXPANSION_FACTOR ?? 2, 1, 3);
  const maxPool = Math.max(1, Math.min(12, Number(options.maxPool ?? process.env.TYCHO_WORLD_MODEL_MAX_POOL ?? 12)));
  const explorationWeight = clamp(options.explorationWeight ?? process.env.TYCHO_WORLD_MODEL_EXPLORATION_WEIGHT ?? 0.12, 0, 1);
  const costWeight = clamp(options.costWeight ?? process.env.TYCHO_WORLD_MODEL_COST_WEIGHT ?? 0.05, 0, 1);

  async function generate(input) {
    const requested = Number(input.count);
    if (!Number.isInteger(requested) || requested <= 0) throw new Error("World-model generator requires a positive input.count.");
    const expanded = mode === "online" ? Math.min(maxPool, Math.max(requested, Math.ceil(requested * expansionFactor))) : requested;
    const generated = await baseGenerator({ ...input, count: expanded });
    if (!Array.isArray(generated?.variants) || generated.variants.length !== expanded) {
      throw new Error(`World-model base generator produced ${Array.isArray(generated?.variants) ? generated.variants.length : 0} variants; expected ${expanded}.`);
    }
    if (mode === "off") return generated;
    const predicted = await worldModel.predictBatch({ workspaceId: input.workspaceId, input, variants: generated.variants });
    const ranked = predicted.map(({ variant, prediction }, index) => {
      const normalizedCost = Math.min(1, Math.max(0, prediction.expectedWallSeconds || 0) / 120);
      const utility = prediction.expectedReward + explorationWeight * prediction.uncertainty - costWeight * normalizedCost;
      return { variant, prediction, index, utility };
    }).sort((a, b) => (b.utility - a.utility) || (b.prediction.confidence - a.prediction.confidence) || (a.index - b.index) || String(a.variant.id).localeCompare(String(b.variant.id)));
    const selectedIds = new Set((mode === "online" ? ranked.slice(0, requested) : ranked).map((item) => item.variant.id));
    const selectedRank = new Map(ranked.map((item, index) => [item.variant.id, index + 1]));
    const variants = generated.variants
      .filter((variant) => selectedIds.has(variant.id))
      .map((variant) => {
        const item = ranked.find((entry) => entry.variant.id === variant.id);
        return annotate(variant, item.prediction, {
          mode,
          utility: item.utility,
          rank: selectedRank.get(variant.id),
          requestedCount: requested,
          predictedPoolSize: expanded,
          estimatedTychoJobsAvoided: Math.max(0, expanded - requested),
        });
      });
    if (variants.length !== requested) throw new Error(`World-model preselector returned ${variants.length} variants; expected ${requested}.`);
    return {
      ...generated,
      variants,
      worldModelPlan: {
        mode,
        requestedCount: requested,
        predictedPoolSize: expanded,
        estimatedTychoJobsAvoided: Math.max(0, expanded - requested),
      },
    };
  }

  async function status(workspaceId = null) {
    return {
      mode,
      expansionFactor,
      maxPool,
      explorationWeight,
      costWeight,
      model: await worldModel.report(workspaceId),
    };
  }

  return { generate, status, mode };
}
