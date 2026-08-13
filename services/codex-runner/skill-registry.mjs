import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSkill, skillRef, validateSkill } from "./skill-schema.mjs";

export function createSkillRegistry(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.env.TYCHO_LEARNING_STATE_DIR || path.join(os.homedir(), ".nodes-ai-canvas", "learning"));
  const skillDir = path.join(rootDir, "skills");
  let writeChain = Promise.resolve();

  async function ensure() {
    await mkdir(skillDir, { recursive: true, mode: 0o700 });
  }

  const fileName = (skill) => `${skill.skillId}@${skill.version}.json`;

  async function write(skill) {
    await ensure();
    const validated = validateSkill(skill);
    const target = path.join(skillDir, fileName(validated));
    const snapshot = `${JSON.stringify(validated, null, 2)}\n`;
    writeChain = writeChain.then(async () => {
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, target);
    });
    await writeChain;
    return validated;
  }

  async function list(filter = {}) {
    await ensure();
    const values = [];
    for (const name of (await readdir(skillDir)).filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        const skill = validateSkill(JSON.parse(await readFile(path.join(skillDir, name), "utf8")));
        if (filter.status && skill.status !== filter.status) continue;
        if (filter.domain && skill.domain !== filter.domain) continue;
        if (filter.skillId && skill.skillId !== filter.skillId) continue;
        values.push(skill);
      } catch {
        // Malformed skill files are ignored instead of poisoning retrieval.
      }
    }
    return values;
  }

  async function latest(skillId) {
    const matches = await list({ skillId });
    return matches.sort((a, b) => b.version - a.version)[0] || null;
  }

  async function upsertCandidate(input) {
    const candidate = buildSkill(input);
    const current = await latest(candidate.skillId);
    if (!current) return write(candidate);
    const sameMechanism = current.mechanism === candidate.mechanism;
    if (sameMechanism && ["candidate", "validating"].includes(current.status)) {
      return write(buildSkill({
        ...current,
        ...candidate,
        version: current.version,
        status: current.status,
        createdAt: current.createdAt,
        sourceTrajectoryIds: [...new Set([...(current.sourceTrajectoryIds || []), ...(candidate.sourceTrajectoryIds || [])])],
        evidence: {
          ...current.evidence,
          ...candidate.evidence,
          support: Math.max(current.evidence?.support || 0, candidate.evidence?.support || 0),
        },
        updatedAt: new Date().toISOString(),
      }));
    }
    const nextVersion = current.version + 1;
    const next = buildSkill({ ...candidate, version: nextVersion, supersedes: skillRef(current) });
    await write(buildSkill({ ...current, status: "superseded", supersededBy: skillRef(next), updatedAt: new Date().toISOString() }));
    return write(next);
  }

  async function transition(ref, status, evidence = null) {
    const [skillId, versionRaw] = String(ref).split("@");
    const version = Number(versionRaw);
    const matches = await list({ skillId });
    const current = matches.find((skill) => skill.version === version);
    if (!current) throw new Error(`Skill not found: ${ref}.`);
    return write(buildSkill({
      ...current,
      status,
      evidence: evidence ? { ...current.evidence, ...evidence } : current.evidence,
      updatedAt: new Date().toISOString(),
    }));
  }

  async function stats() {
    const skills = await list();
    const byStatus = {};
    for (const skill of skills) byStatus[skill.status] = (byStatus[skill.status] || 0) + 1;
    return { count: skills.length, byStatus };
  }

  return { rootDir, skillDir, list, latest, write, upsertCandidate, transition, stats };
}
