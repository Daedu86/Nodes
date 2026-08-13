const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

export const PLANNER_SCHEMA_VERSION = 1;
export const PLANNER_VERSION = "empirical-mpc-v1";

function modeOf(value) {
  const mode = String(value || process.env.TYCHO_PLANNER_MODE || "off").trim().toLowerCase();
  if (!["off", "observe", "online"].includes(mode)) throw new Error("TYCHO_PLANNER_MODE must be off, observe, or online.");
  return mode;
}

function boundedNumber(value, fallback, min, max, label) {
  const resolved = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(resolved) || resolved < min || resolved > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return resolved;
}

function stateKey(state) {
  if (!isRecord(state)) return "unknown";
  return ["decision", "passBand", "blockedBand", "speedBand"]
    .map((key) => `${key}=${asString(state[key]) || "unknown"}`)
    .join("|");
}

function groupTransitions(trajectories, currentStateKey, minSupport) {
  const groups = new Map();
  for (const item of trajectories) {
    if (item?.stateKey !== currentStateKey || !Number.isFinite(item.reward)) continue;
    const actionId = asString(item.actionId) || "exploit";
    const bucket = groups.get(actionId) || [];
    bucket.push(item);
    groups.set(actionId, bucket);
  }
  const transitions = [];
  for (const [actionId, items] of groups) {
    const meanReward = items.reduce((sum, item) => sum + item.reward, 0) / items.length;
    const variance = items.reduce((sum, item) => sum + ((item.reward - meanReward) ** 2), 0) / items.length;
    const nextWeights = new Map();
    for (const item of items) {
      const key = stateKey(item.nextState);
      nextWeights.set(key, (nextWeights.get(key) || 0) + 1);
    }
    const ranked = [...nextWeights.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
    const nextStateKey = ranked[0]?.[0] || "unknown";
    const transitionProbability = ranked.length ? ranked[0][1] / items.length : 0;
    const supportConfidence = Math.min(1, items.length / minSupport);
    const stability = 1 - Math.min(0.8, Math.sqrt(Math.max(0, variance)));
    const confidence = clamp01(supportConfidence * transitionProbability * stability);
    transitions.push({ actionId, meanReward: clamp01(meanReward), support: items.length, confidence, uncertainty: clamp01(1 - confidence), nextStateKey });
  }
  return transitions.sort((a, b) => (b.meanReward - a.meanReward) || (b.confidence - a.confidence) || a.actionId.localeCompare(b.actionId));
}

function normalizedReturn(total, discountSum) {
  return discountSum > 0 ? clamp01(total / discountSum) : 0;
}

export function createModelBasedPlanner(options = {}) {
  if (!options.trajectoryStore || typeof options.trajectoryStore.list !== "function") throw new Error("Model-based planner requires a trajectoryStore.");
  const trajectoryStore = options.trajectoryStore;
  const mode = modeOf(options.mode);
  const maxDepth = Math.round(boundedNumber(options.maxDepth ?? process.env.TYCHO_PLANNER_MAX_DEPTH, 4, 1, 8, "TYCHO_PLANNER_MAX_DEPTH"));
  const maxBranches = Math.round(boundedNumber(options.maxBranches ?? process.env.TYCHO_PLANNER_MAX_BRANCHES, 12, 1, 64, "TYCHO_PLANNER_MAX_BRANCHES"));
  const gamma = boundedNumber(options.gamma ?? process.env.TYCHO_PLANNER_GAMMA, 0.85, 0, 1, "TYCHO_PLANNER_GAMMA");
  const minConfidence = boundedNumber(options.minConfidence ?? process.env.TYCHO_PLANNER_MIN_CONFIDENCE, 0.55, 0, 1, "TYCHO_PLANNER_MIN_CONFIDENCE");
  const uncertaintyPenalty = boundedNumber(options.uncertaintyPenalty ?? process.env.TYCHO_PLANNER_UNCERTAINTY_PENALTY, 0.15, 0, 1, "TYCHO_PLANNER_UNCERTAINTY_PENALTY");
  const minSupport = Math.round(boundedNumber(options.minSupport ?? process.env.TYCHO_PLANNER_MIN_SUPPORT, 3, 1, 1000, "TYCHO_PLANNER_MIN_SUPPORT"));
  const timeoutMs = Math.round(boundedNumber(options.timeoutMs ?? process.env.TYCHO_PLANNER_TIMEOUT_MS, 150, 10, 5000, "TYCHO_PLANNER_TIMEOUT_MS"));

  async function planPrediction({ workspaceId, prediction }) {
    const startedAt = Date.now();
    const trajectories = await trajectoryStore.list(workspaceId ? { workspaceId } : {});
    const initialReward = clamp01(prediction?.expectedReward ?? 0.5);
    const initialConfidence = clamp01(prediction?.confidence ?? 0);
    const initialUncertainty = clamp01(prediction?.uncertainty ?? (1 - initialConfidence));
    const initialStateKey = asString(prediction?.likelyNextState?.stateKey);
    const firstPenalty = uncertaintyPenalty * initialUncertainty;
    const initialTotal = Math.max(0, initialReward - firstPenalty);
    if (mode === "off" || maxDepth <= 1 || !initialStateKey || initialConfidence < minConfidence) {
      return {
        schemaVersion: PLANNER_SCHEMA_VERSION,
        plannerVersion: PLANNER_VERSION,
        mode,
        expectedReturn: initialReward,
        planningUtility: clamp01(initialTotal),
        depthReached: 1,
        branchesEvaluated: 0,
        confidence: initialConfidence,
        uncertainty: initialUncertainty,
        stopReason: mode === "off" ? "disabled" : !initialStateKey ? "missing-next-state" : initialConfidence < minConfidence ? "low-confidence" : "depth-limit",
        path: [],
      };
    }

    let beam = [{ stateKey: initialStateKey, total: initialTotal, discountSum: 1, confidence: initialConfidence, path: [] }];
    let best = beam[0];
    let branchesEvaluated = 0;
    let stopReason = "depth-limit";

    for (let depth = 2; depth <= maxDepth; depth += 1) {
      if (Date.now() - startedAt >= timeoutMs) { stopReason = "timeout"; break; }
      const expanded = [];
      const discount = gamma ** (depth - 1);
      for (const node of beam) {
        const transitions = groupTransitions(trajectories, node.stateKey, minSupport).slice(0, maxBranches);
        for (const transition of transitions) {
          branchesEvaluated += 1;
          if (branchesEvaluated > maxBranches * maxDepth) break;
          const stepValue = Math.max(0, transition.meanReward - uncertaintyPenalty * transition.uncertainty);
          expanded.push({
            stateKey: transition.nextStateKey,
            total: node.total + discount * stepValue,
            discountSum: node.discountSum + discount,
            confidence: Math.min(node.confidence, transition.confidence),
            path: [...node.path, {
              depth,
              stateKey: node.stateKey,
              actionId: transition.actionId,
              expectedReward: transition.meanReward,
              confidence: transition.confidence,
              uncertainty: transition.uncertainty,
              nextStateKey: transition.nextStateKey,
              support: transition.support,
            }],
          });
        }
      }
      if (!expanded.length) { stopReason = "no-supported-transition"; break; }
      beam = expanded
        .sort((a, b) => (normalizedReturn(b.total, b.discountSum) - normalizedReturn(a.total, a.discountSum)) || (b.confidence - a.confidence) || a.stateKey.localeCompare(b.stateKey))
        .slice(0, maxBranches);
      best = beam[0];
      if (best.confidence < minConfidence) { stopReason = "low-confidence"; break; }
    }

    const expectedReturn = normalizedReturn(best.total, best.discountSum);
    return {
      schemaVersion: PLANNER_SCHEMA_VERSION,
      plannerVersion: PLANNER_VERSION,
      mode,
      expectedReturn,
      planningUtility: clamp01(expectedReturn - uncertaintyPenalty * (1 - best.confidence)),
      depthReached: 1 + best.path.length,
      branchesEvaluated,
      confidence: best.confidence,
      uncertainty: clamp01(1 - best.confidence),
      stopReason,
      path: best.path,
    };
  }

  async function planBatch({ workspaceId, predictions }) {
    return Promise.all(predictions.map(async (item) => ({ ...item, plan: await planPrediction({ workspaceId, prediction: item.prediction }) })));
  }

  async function status(workspaceId = null) {
    const trajectories = await trajectoryStore.list(workspaceId ? { workspaceId } : {});
    const stateActions = new Set(trajectories.filter((item) => item?.stateKey && item?.actionId).map((item) => `${item.stateKey}|${item.actionId}`));
    return {
      schemaVersion: PLANNER_SCHEMA_VERSION,
      plannerVersion: PLANNER_VERSION,
      mode,
      maxDepth,
      maxBranches,
      gamma,
      minConfidence,
      uncertaintyPenalty,
      minSupport,
      timeoutMs,
      observations: trajectories.length,
      modeledStateActions: stateActions.size,
      ready: trajectories.length >= minSupport && stateActions.size > 0,
    };
  }

  return { mode, planPrediction, planBatch, status };
}
