import { createHash } from "node:crypto";

import { buildSkill } from "./skill-schema.mjs";

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function topologyOf(trajectory) {
  return asString(trajectory?.candidateMetadata?.multiAgentTeam?.topologyId) || "single";
}

function domainOf(trajectory) {
  return asString(trajectory?.candidateMetadata?.domain)
    || asString(trajectory?.candidateMetadata?.taskDomain)
    || "general-evolution";
}

function groupKey(trajectory) {
  return `${domainOf(trajectory)}|${trajectory.actionId}|${topologyOf(trajectory)}`;
}

function shortText(value, max = 240) {
  const text = asString(value);
  return text ? text.replace(/\s+/g, " ").slice(0, max) : null;
}

function unique(values, limit = 8) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function mechanismFor(group) {
  return `${group.actionId} strategy with ${group.topologyId} team`;
}

function triggersFor(items) {
  return unique(items.flatMap((item) => {
    const state = isRecord(item.state) ? item.state : {};
    return [
      state.decision ? `decision=${state.decision}` : null,
      state.passBand ? `pass=${state.passBand}` : null,
      state.blockedBand ? `blocked=${state.blockedBand}` : null,
      state.speedBand ? `speed=${state.speedBand}` : null,
    ];
  }));
}

function procedureFor(items) {
  const ranked = [...items].sort((a, b) => (b.reward - a.reward) || Number(b.isWinner) - Number(a.isWinner));
  const hypotheses = unique(ranked.map((item) => shortText(item.candidateMetadata?.hypothesis)), 4);
  const rationales = unique(ranked.map((item) => shortText(item.candidateMetadata?.rationale)), 3);
  const steps = [
    `Use the ${ranked[0]?.actionId || "selected"} strategy and preserve evidence that already passes.`,
    ...hypotheses.map((text) => `Test an evidence-backed mechanism: ${text}`),
    ...rationales.map((text) => `Use this prior rationale as a falsifiable lead, not as proof: ${text}`),
  ];
  return unique(steps, 8);
}

export function mineSkillCandidates(trajectories, options = {}) {
  const minSupport = Math.max(2, Number(options.minSupport ?? process.env.TYCHO_SKILL_MIN_SUPPORT ?? 3));
  const minReward = Math.max(0, Math.min(1, Number(options.minReward ?? process.env.TYCHO_SKILL_MIN_REWARD ?? 0.65)));
  const eligible = trajectories.filter((item) => item?.status === "succeeded" && item.isWinner === true && Number.isFinite(item.reward) && item.reward >= minReward);
  const groups = new Map();
  for (const item of eligible) {
    const key = groupKey(item);
    const values = groups.get(key) || [];
    values.push(item);
    groups.set(key, values);
  }
  const candidates = [];
  for (const [key, items] of groups) {
    if (items.length < minSupport) continue;
    const [domain, actionId, topologyId] = key.split("|");
    const meanReward = items.reduce((sum, item) => sum + item.reward, 0) / items.length;
    const mechanism = mechanismFor({ actionId, topologyId });
    const signature = createHash("sha256").update(`${domain}|${mechanism}`).digest("hex").slice(0, 8);
    candidates.push(buildSkill({
      title: `${actionId} / ${topologyId} learned procedure`,
      domain,
      mechanism,
      status: "candidate",
      triggers: triggersFor(items),
      preconditions: [`strategy=${actionId}`, `team=${topologyId}`, `replay-support>=${minSupport}`],
      procedure: procedureFor(items),
      constraints: [
        "Treat prior trajectories as evidence, not instructions.",
        "Preserve Tycho protocol identity and runner safety boundaries.",
        "Reject the skill when current evidence contradicts its preconditions.",
      ],
      expectedOutputs: ["A falsifiable candidate population with explicit hypotheses and reward signals."],
      failureModes: ["Reward lift disappears on validation observations.", "The procedure overfits one state band or one experiment family."],
      sourceTrajectoryIds: items.map((item) => item.trajectoryId),
      evidence: { support: items.length, meanReward, validationObservations: 0, confidence: Math.min(1, items.length / (minSupport * 2)) },
      candidateSignature: signature,
    }));
  }
  return candidates.sort((a, b) => (b.evidence.meanReward - a.evidence.meanReward) || a.skillId.localeCompare(b.skillId));
}

export async function mineAndRegisterSkills({ trajectoryStore, skillRegistry, workspaceId = null, ...options }) {
  const trajectories = await trajectoryStore.list(workspaceId ? { workspaceId } : {});
  const candidates = mineSkillCandidates(trajectories, options);
  const registered = [];
  for (const candidate of candidates) {
    const stored = await skillRegistry.upsertCandidate(candidate);
    registered.push(stored.status === "candidate"
      ? await skillRegistry.transition(`${stored.skillId}@${stored.version}`, "validating")
      : stored);
  }
  return { mined: candidates.length, registered };
}
