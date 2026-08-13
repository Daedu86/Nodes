import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TEAM_POLICY_SCHEMA_VERSION = 1;

export const TEAM_TOPOLOGIES = Object.freeze([
  { id: "single", description: "One generalist hypothesis agent." },
  { id: "parallel-specialists", description: "Independent specialist agents split the requested population." },
  { id: "proposer-critic", description: "A proposer drafts variants and a critic produces corrected replacements from that evidence." },
  { id: "debate", description: "Conservative and radical agents propose alternatives, then a synthesizer resolves the disagreement." },
]);

const TOPOLOGY_BY_ID = new Map(TEAM_TOPOLOGIES.map((item) => [item.id, item]));
const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));
const asFinite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function teamContextKey(stateKey, strategyActionId) {
  return `${String(stateKey || "unknown")}|strategy=${String(strategyActionId || "unknown")}`;
}

function deterministicUnit(seed) {
  const digest = createHash("sha256").update(String(seed)).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

function freshPolicy() {
  return {
    schemaVersion: TEAM_POLICY_SCHEMA_VERSION,
    version: 0,
    values: {},
    visits: {},
    appliedOutcomes: {},
    updatedAt: null,
  };
}

function normalizePolicy(value) {
  if (!isRecord(value) || value.schemaVersion !== TEAM_POLICY_SCHEMA_VERSION) return freshPolicy();
  return {
    schemaVersion: TEAM_POLICY_SCHEMA_VERSION,
    version: Number.isInteger(value.version) && value.version >= 0 ? value.version : 0,
    values: isRecord(value.values) ? value.values : {},
    visits: isRecord(value.visits) ? value.visits : {},
    appliedOutcomes: isRecord(value.appliedOutcomes) ? value.appliedOutcomes : {},
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

export function createTeamPolicyController(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.env.TYCHO_LEARNING_STATE_DIR || path.join(os.homedir(), ".nodes-ai-canvas", "learning"));
  const policyPath = path.join(rootDir, "team-policy.json");
  const mode = options.mode || process.env.TYCHO_MULTI_AGENT_MODE || "off";
  if (!["off", "observe", "online"].includes(mode)) throw new Error("TYCHO_MULTI_AGENT_MODE must be off, observe, or online.");
  const alpha = clamp01(asFinite(options.alpha ?? process.env.TYCHO_MULTI_AGENT_ALPHA, 0.25));
  const epsilon = clamp01(asFinite(options.epsilon ?? process.env.TYCHO_MULTI_AGENT_EPSILON, 0.12));
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

  function ensureContext(contextKey) {
    policy.values[contextKey] ??= {};
    policy.visits[contextKey] ??= {};
    for (const topology of TEAM_TOPOLOGIES) {
      if (!Number.isFinite(policy.values[contextKey][topology.id])) policy.values[contextKey][topology.id] = 0;
      if (!Number.isInteger(policy.visits[contextKey][topology.id])) policy.visits[contextKey][topology.id] = 0;
    }
  }

  function valueFor(contextKey, topologyId) {
    return asFinite(policy.values?.[contextKey]?.[topologyId], 0);
  }

  async function persist() {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    const snapshot = `${JSON.stringify(policy, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      const temporary = `${policyPath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, policyPath);
    });
    await writeChain;
  }

  async function select({ stateKey, strategyActionId, seedKey }) {
    await load();
    const contextKey = teamContextKey(stateKey, strategyActionId);
    ensureContext(contextKey);
    if (mode === "off") {
      return {
        contextKey,
        topology: TOPOLOGY_BY_ID.get("single"),
        mode: "off",
        teamPolicyVersion: `t${policy.version}`,
        value: valueFor(contextKey, "single"),
        epsilon: 0,
      };
    }
    const ranked = TEAM_TOPOLOGIES.map((topology, index) => ({ topology, index, value: valueFor(contextKey, topology.id) }))
      .sort((a, b) => (b.value - a.value) || (a.index - b.index));
    const explore = deterministicUnit(`${seedKey}|team-explore`) < epsilon;
    let selected = ranked[0];
    if (explore) {
      const index = Math.floor(deterministicUnit(`${seedKey}|team-action`) * TEAM_TOPOLOGIES.length) % TEAM_TOPOLOGIES.length;
      selected = { topology: TEAM_TOPOLOGIES[index], index, value: valueFor(contextKey, TEAM_TOPOLOGIES[index].id) };
    }
    return {
      contextKey,
      topology: selected.topology,
      mode: explore ? "explore" : "exploit",
      teamPolicyVersion: `t${policy.version}`,
      value: selected.value,
      epsilon,
    };
  }

  async function update({ outcomeId, contextKey, topologyId, reward }) {
    await load();
    if (!TOPOLOGY_BY_ID.has(topologyId)) throw new Error(`Unknown team topology: ${topologyId}`);
    const normalizedOutcomeId = typeof outcomeId === "string" && outcomeId.trim() ? outcomeId.trim() : null;
    if (normalizedOutcomeId && policy.appliedOutcomes[normalizedOutcomeId]) {
      return { updated: false, duplicate: true, teamPolicyVersion: `t${policy.version}` };
    }
    if (mode !== "online") return { updated: false, teamPolicyVersion: `t${policy.version}` };
    ensureContext(contextKey);
    const current = valueFor(contextKey, topologyId);
    const next = current + (alpha * (clamp01(reward) - current));
    policy.values[contextKey][topologyId] = next;
    policy.visits[contextKey][topologyId] += 1;
    policy.version += 1;
    policy.updatedAt = new Date().toISOString();
    if (normalizedOutcomeId) policy.appliedOutcomes[normalizedOutcomeId] = policy.updatedAt;
    await persist();
    return { updated: true, value: next, teamPolicyVersion: `t${policy.version}` };
  }

  async function trainOffline(trajectories, options = {}) {
    await load();
    if (options.reset === true) policy = freshPolicy();
    const ordered = [...trajectories].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.trajectoryId).localeCompare(String(b.trajectoryId)));
    let updates = 0;
    for (const trajectory of ordered) {
      const team = trajectory?.candidateMetadata?.multiAgentTeam;
      if (!isRecord(team) || !team.contextKey || !team.topologyId || !Number.isFinite(trajectory.reward)) continue;
      const outcomeId = `offline-team:${trajectory.trajectoryId}`;
      if (policy.appliedOutcomes[outcomeId]) continue;
      ensureContext(team.contextKey);
      const current = valueFor(team.contextKey, team.topologyId);
      policy.values[team.contextKey][team.topologyId] = current + (alpha * (clamp01(trajectory.reward) - current));
      policy.visits[team.contextKey][team.topologyId] += 1;
      policy.version += 1;
      policy.updatedAt = new Date().toISOString();
      policy.appliedOutcomes[outcomeId] = policy.updatedAt;
      updates += 1;
    }
    await persist();
    return { updates, teamPolicyVersion: `t${policy.version}` };
  }

  async function status() {
    await load();
    return {
      schemaVersion: TEAM_POLICY_SCHEMA_VERSION,
      mode,
      alpha,
      epsilon,
      teamPolicyVersion: `t${policy.version}`,
      contextCount: Object.keys(policy.values).length,
      appliedOutcomeCount: Object.keys(policy.appliedOutcomes).length,
      updatedAt: policy.updatedAt,
      topologies: TEAM_TOPOLOGIES.map((item) => item.id),
    };
  }

  return { rootDir, policyPath, mode, select, update, trainOffline, status };
}
