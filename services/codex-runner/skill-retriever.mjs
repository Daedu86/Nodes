import { createHash } from "node:crypto";
import { skillRef } from "./skill-schema.mjs";

const clamp01 = (value) => Math.min(1, Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0));

function deterministicUnit(seed) {
  const digest = createHash("sha256").update(String(seed)).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

function relevance(skill, context) {
  let score = skill.evidence?.meanReward || 0;
  const triggers = new Set(skill.triggers || []);
  if (context.state?.decision && triggers.has(`decision=${context.state.decision}`)) score += 0.15;
  if (context.state?.passBand && triggers.has(`pass=${context.state.passBand}`)) score += 0.1;
  if (context.state?.blockedBand && triggers.has(`blocked=${context.state.blockedBand}`)) score += 0.1;
  if (context.state?.speedBand && triggers.has(`speed=${context.state.speedBand}`)) score += 0.05;
  if ((skill.preconditions || []).includes(`strategy=${context.strategyActionId}`)) score += 0.25;
  if (context.topologyId && (skill.preconditions || []).includes(`team=${context.topologyId}`)) score += 0.15;
  return score;
}

function toGuidance(skill, experimental) {
  return {
    ref: skillRef(skill),
    title: skill.title,
    domain: skill.domain,
    status: skill.status,
    experimental,
    triggers: skill.triggers,
    preconditions: skill.preconditions,
    procedure: skill.procedure,
    constraints: skill.constraints,
    failureModes: skill.failureModes,
    evidence: skill.evidence,
  };
}

export function createSkillRetriever(options = {}) {
  if (!options.skillRegistry) throw new Error("Skill retriever requires a skillRegistry.");
  const registry = options.skillRegistry;
  const mode = options.mode || process.env.TYCHO_SKILL_MODE || "off";
  const topK = Math.max(0, Math.min(5, Number(options.topK ?? process.env.TYCHO_SKILL_TOP_K ?? 2)));
  const exploration = clamp01(options.exploration ?? process.env.TYCHO_SKILL_EXPLORATION ?? 0.15);

  async function retrieve(context) {
    if (mode === "off" || topK === 0) return { mode, skills: [], skillRefs: [] };
    const all = await registry.list();
    const promoted = all.filter((skill) => skill.status === "promoted")
      .map((skill) => ({ skill, score: relevance(skill, context) }))
      .sort((a, b) => (b.score - a.score) || a.skill.skillId.localeCompare(b.skill.skillId))
      .slice(0, topK)
      .map(({ skill }) => toGuidance(skill, false));

    let experimental = null;
    if (mode === "online" && promoted.length < topK && deterministicUnit(`${context.seedKey}|skill-explore`) < exploration) {
      const validating = all.filter((skill) => skill.status === "validating")
        .map((skill) => ({ skill, score: relevance(skill, context) }))
        .sort((a, b) => (b.score - a.score) || a.skill.skillId.localeCompare(b.skill.skillId));
      if (validating.length) {
        const index = Math.floor(deterministicUnit(`${context.seedKey}|skill-choice`) * validating.length) % validating.length;
        experimental = toGuidance(validating[index].skill, true);
      }
    }
    const skills = [...promoted, ...(experimental ? [experimental] : [])].slice(0, topK);
    return { mode, skills, skillRefs: skills.map((skill) => skill.ref) };
  }

  async function status() {
    return { mode, topK, exploration, registry: await registry.stats() };
  }

  return { mode, topK, exploration, retrieve, status };
}
