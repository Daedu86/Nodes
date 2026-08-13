import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const POLICY_SCHEMA_VERSION = 1;

export const POLICY_ACTIONS = Object.freeze([
  {
    id: "exploit",
    directive: "Exploit the strongest observed hypothesis. Make conservative, evidence-backed refinements around the current champion and preserve already-passing behavior.",
  },
  {
    id: "repair",
    directive: "Repair failure evidence first. Target failed or blocked checks directly, minimize unrelated changes, and propose variants that falsify the suspected failure mechanism.",
  },
  {
    id: "diversify",
    directive: "Explore structurally different hypotheses. Deliberately vary mechanisms rather than parameter-only tweaks while remaining inside the same objective and safety boundaries.",
  },
  {
    id: "efficiency",
    directive: "Optimize execution efficiency while preserving correctness. Prefer fewer steps, lower wall time, and simpler experiment structure when evidence permits.",
  },
  {
    id: "robustness",
    directive: "Stress robustness. Add falsifiers and edge-case coverage, reduce blocked behavior, and prefer hypotheses that remain correct under stronger checks.",
  },
]);

const ACTION_BY_ID = new Map(POLICY_ACTIONS.map((action) => [action.id, action]));
const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const asFinite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function bucket(value, thresholds, labels) {
  for (let index = 0; index < thresholds.length; index += 1) {
    if (value < thresholds[index]) return labels[index];
  }
  return labels[labels.length - 1];
}

export function derivePolicyState(evaluation) {
  if (!isRecord(evaluation)) {
    return {
      decision: "none",
      passBand: "unknown",
      blockedBand: "unknown",
      speedBand: "unknown",
    };
  }
  const metrics = isRecord(evaluation.metrics) ? evaluation.metrics : {};
  const evidence = isRecord(evaluation.evidence) ? evaluation.evidence : {};
  const summary = isRecord(evidence.summary) ? evidence.summary : {};
  const decision = typeof evidence.decision === "string" ? evidence.decision : "unknown";
  const passRatio = clamp01(asFinite(metrics.passRatio, 0));
  const stepCount = Math.max(0, asFinite(summary.stepCount, 0));
  const blockedSteps = Math.max(0, asFinite(metrics.blockedSteps, asFinite(summary.blockedSteps, 0)));
  const blockedRatio = stepCount > 0 ? clamp01(blockedSteps / stepCount) : 0;
  const wallSeconds = Math.max(0, asFinite(metrics.wallSeconds, 0));
  return {
    decision,
    passBand: bucket(passRatio, [0.5, 0.9], ["low", "mid", "high"]),
    blockedBand: bucket(blockedRatio, [0.01, 0.25], ["none", "some", "high"]),
    speedBand: bucket(wallSeconds, [5, 30], ["fast", "mid", "slow"]),
  };
}

export function policyStateKey(state) {
  return `decision=${state.decision}|pass=${state.passBand}|blocked=${state.blockedBand}|speed=${state.speedBand}`;
}

function deterministicUnit(seed) {
  const digest = createHash("sha256").update(String(seed)).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

function freshPolicy() {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    version: 0,
    q: {},
    visits: {},
    appliedTransitions: {},
    updatedAt: null,
  };
}

function normalizePolicy(value) {
  if (!isRecord(value) || value.schemaVersion !== POLICY_SCHEMA_VERSION) return freshPolicy();
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    version: Number.isInteger(value.version) && value.version >= 0 ? value.version : 0,
    q: isRecord(value.q) ? value.q : {},
    visits: isRecord(value.visits) ? value.visits : {},
    appliedTransitions: isRecord(value.appliedTransitions) ? value.appliedTransitions : {},
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

export function createPolicyController(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.env.TYCHO_LEARNING_STATE_DIR || path.join(os.homedir(), ".nodes-ai-canvas", "learning"));
  const policyPath = path.join(rootDir, "policy.json");
  const mode = options.mode || process.env.TYCHO_LEARNING_MODE || "off";
  const alpha = clamp01(asFinite(options.alpha ?? process.env.TYCHO_LEARNING_ALPHA, 0.25));
  const gamma = clamp01(asFinite(options.gamma ?? process.env.TYCHO_LEARNING_GAMMA, 0.85));
  const epsilon = clamp01(asFinite(options.epsilon ?? process.env.TYCHO_LEARNING_EPSILON, 0.15));
  let loaded = false;
  let policy = freshPolicy();
  let writeChain = Promise.resolve();

  async function load() {
    if (loaded) return policy;
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    try { policy = normalizePolicy(JSON.parse(await readFile(policyPath, "utf8"))); }
    catch { policy = freshPolicy(); }
    loaded = true;
    return policy;
  }

  function qFor(stateKey, actionId) {
    return asFinite(policy.q?.[stateKey]?.[actionId], 0);
  }

  function ensureState(stateKey) {
    policy.q[stateKey] ??= {};
    policy.visits[stateKey] ??= {};
    for (const action of POLICY_ACTIONS) {
      if (!Number.isFinite(policy.q[stateKey][action.id])) policy.q[stateKey][action.id] = 0;
      if (!Number.isInteger(policy.visits[stateKey][action.id])) policy.visits[stateKey][action.id] = 0;
    }
  }

  async function persist() {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    const snapshot = JSON.stringify(policy, null, 2) + "\n";
    writeChain = writeChain.then(async () => {
      const temporary = `${policyPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, policyPath);
    });
    await writeChain;
  }

  async function select({ state, seedKey }) {
    await load();
    const stateKey = policyStateKey(state);
    ensureState(stateKey);
    if (mode === "off") {
      const action = ACTION_BY_ID.get("exploit");
      return { stateKey, state, action, mode: "off", policyVersion: `q${policy.version}`, qValue: 0, epsilon: 0 };
    }
    const ranked = POLICY_ACTIONS.map((action) => ({ action, q: qFor(stateKey, action.id) }))
      .sort((a, b) => (b.q - a.q) || a.action.id.localeCompare(b.action.id));
    const explore = deterministicUnit(`${seedKey}|explore`) < epsilon;
    let selected = ranked[0];
    if (explore) {
      const index = Math.floor(deterministicUnit(`${seedKey}|action`) * POLICY_ACTIONS.length) % POLICY_ACTIONS.length;
      const action = POLICY_ACTIONS[index];
      selected = { action, q: qFor(stateKey, action.id) };
    }
    return {
      stateKey,
      state,
      action: selected.action,
      mode: explore ? "explore" : "exploit",
      policyVersion: `q${policy.version}`,
      qValue: selected.q,
      epsilon,
    };
  }

  function applyUpdate({ stateKey, actionId, reward, nextStateKey }) {
    if (!ACTION_BY_ID.has(actionId)) throw new Error(`Unknown policy action: ${actionId}`);
    ensureState(stateKey);
    ensureState(nextStateKey);
    const current = qFor(stateKey, actionId);
    const maxNext = Math.max(...POLICY_ACTIONS.map((action) => qFor(nextStateKey, action.id)));
    const target = clamp01(reward) + (gamma * maxNext);
    const updated = current + (alpha * (target - current));
    policy.q[stateKey][actionId] = updated;
    policy.visits[stateKey][actionId] += 1;
    policy.version += 1;
    policy.updatedAt = new Date().toISOString();
    return updated;
  }

  async function update(input) {
    await load();
    const transitionId = typeof input.transitionId === "string" && input.transitionId.trim() ? input.transitionId.trim() : null;
    if (transitionId && policy.appliedTransitions[transitionId]) {
      return { updated: false, duplicate: true, policyVersion: `q${policy.version}` };
    }
    if (mode !== "online") return { updated: false, policyVersion: `q${policy.version}` };
    const nextStateKey = policyStateKey(input.nextState);
    const qValue = applyUpdate({ ...input, nextStateKey });
    if (transitionId) policy.appliedTransitions[transitionId] = new Date().toISOString();
    await persist();
    return { updated: true, qValue, nextStateKey, policyVersion: `q${policy.version}` };
  }

  async function trainOffline(trajectories, options = {}) {
    await load();
    if (options.reset === true) policy = freshPolicy();
    const ordered = [...trajectories].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.trajectoryId).localeCompare(String(b.trajectoryId)));
    let updates = 0;
    for (const trajectory of ordered) {
      if (!trajectory?.stateKey || !trajectory?.actionId || !Number.isFinite(trajectory.reward) || !isRecord(trajectory.nextState)) continue;
      const transitionId = `offline:${trajectory.trajectoryId}`;
      if (policy.appliedTransitions[transitionId]) continue;
      applyUpdate({
        stateKey: trajectory.stateKey,
        actionId: trajectory.actionId,
        reward: trajectory.reward,
        nextStateKey: policyStateKey(trajectory.nextState),
      });
      policy.appliedTransitions[transitionId] = new Date().toISOString();
      updates += 1;
    }
    await persist();
    return { updates, policyVersion: `q${policy.version}` };
  }

  async function status() {
    await load();
    return {
      schemaVersion: POLICY_SCHEMA_VERSION,
      mode,
      alpha,
      gamma,
      epsilon,
      policyVersion: `q${policy.version}`,
      stateCount: Object.keys(policy.q).length,
      appliedTransitionCount: Object.keys(policy.appliedTransitions).length,
      updatedAt: policy.updatedAt,
      actions: POLICY_ACTIONS.map((action) => action.id),
    };
  }

  return { rootDir, policyPath, mode, select, update, trainOffline, status };
}
