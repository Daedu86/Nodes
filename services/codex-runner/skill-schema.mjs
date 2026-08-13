import { createHash } from "node:crypto";

export const SKILL_SCHEMA_VERSION = 1;
export const SKILL_STATUSES = Object.freeze(["candidate", "validating", "promoted", "deprecated", "superseded"]);

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const stringList = (value) => Array.isArray(value) ? value.map(asString).filter(Boolean) : [];

export function stableSkillId(input) {
  const domain = asString(input.domain) || "general";
  const mechanism = asString(input.mechanism) || asString(input.title) || "skill";
  const digest = createHash("sha256").update(`${domain}|${mechanism}`).digest("hex").slice(0, 12);
  const slug = mechanism.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "skill";
  return `${slug}-${digest}`;
}

export function validateSkill(value) {
  if (!isRecord(value) || value.schemaVersion !== SKILL_SCHEMA_VERSION) throw new Error("Skill schemaVersion must equal 1.");
  for (const field of ["skillId", "title", "domain", "status", "createdAt", "updatedAt"]) {
    if (!asString(value[field])) throw new Error(`Skill ${field} is required.`);
  }
  if (!SKILL_STATUSES.includes(value.status)) throw new Error(`Unsupported skill status: ${value.status}.`);
  if (!Number.isInteger(value.version) || value.version <= 0) throw new Error("Skill version must be positive.");
  if (!Array.isArray(value.procedure) || !value.procedure.length || value.procedure.some((step) => !asString(step))) {
    throw new Error("Skill procedure must contain at least one non-empty step.");
  }
  if (!isRecord(value.evidence)) throw new Error("Skill evidence is required.");
  return value;
}

export function buildSkill(input) {
  const now = input.updatedAt || input.createdAt || new Date().toISOString();
  const title = asString(input.title) || "Learned skill";
  const domain = asString(input.domain) || "general";
  const mechanism = asString(input.mechanism) || title;
  return validateSkill({
    schemaVersion: SKILL_SCHEMA_VERSION,
    skillId: asString(input.skillId) || stableSkillId({ domain, mechanism, title }),
    version: Number.isInteger(input.version) && input.version > 0 ? input.version : 1,
    title,
    domain,
    mechanism,
    status: SKILL_STATUSES.includes(input.status) ? input.status : "candidate",
    triggers: stringList(input.triggers),
    preconditions: stringList(input.preconditions),
    procedure: stringList(input.procedure),
    constraints: stringList(input.constraints),
    expectedOutputs: stringList(input.expectedOutputs),
    failureModes: stringList(input.failureModes),
    sourceTrajectoryIds: stringList(input.sourceTrajectoryIds),
    evidence: {
      support: Math.max(0, Number(input.evidence?.support || 0)),
      meanReward: Number.isFinite(input.evidence?.meanReward) ? input.evidence.meanReward : 0,
      validationObservations: Math.max(0, Number(input.evidence?.validationObservations || 0)),
      skillMeanReward: Number.isFinite(input.evidence?.skillMeanReward) ? input.evidence.skillMeanReward : null,
      baselineMeanReward: Number.isFinite(input.evidence?.baselineMeanReward) ? input.evidence.baselineMeanReward : null,
      rewardLift: Number.isFinite(input.evidence?.rewardLift) ? input.evidence.rewardLift : null,
      confidence: Number.isFinite(input.evidence?.confidence) ? input.evidence.confidence : 0,
    },
    supersedes: asString(input.supersedes),
    supersededBy: asString(input.supersededBy),
    createdAt: input.createdAt || now,
    updatedAt: now,
  });
}

export function skillRef(skill) {
  return `${skill.skillId}@${skill.version}`;
}
