import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TRAJECTORY_SCHEMA_VERSION = 1;

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

export function stableSpecHash(spec) {
  return createHash("sha256").update(JSON.stringify(spec ?? null)).digest("hex");
}

export function validateTrajectory(value) {
  if (!isRecord(value) || value.schemaVersion !== TRAJECTORY_SCHEMA_VERSION) throw new Error("Trajectory schemaVersion must equal 1.");
  for (const field of ["trajectoryId", "runId", "sessionId", "workspaceId", "stateKey", "actionId", "candidateKey", "policyVersion", "createdAt"]) {
    if (!asString(value[field])) throw new Error(`Trajectory ${field} is required.`);
  }
  if (!Number.isInteger(value.episodeIndex) || value.episodeIndex <= 0) throw new Error("Trajectory episodeIndex must be positive.");
  if (!Number.isInteger(value.generation) || value.generation <= 0) throw new Error("Trajectory generation must be positive.");
  if (!Number.isFinite(value.reward) || value.reward < 0 || value.reward > 1) throw new Error("Trajectory reward must be between 0 and 1.");
  if (!isRecord(value.state) || !isRecord(value.nextState)) throw new Error("Trajectory state and nextState are required.");
  return value;
}

export function createTrajectoryStore(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.env.TYCHO_LEARNING_STATE_DIR || path.join(os.homedir(), ".nodes-ai-canvas", "learning"));
  const trajectoryDir = path.join(rootDir, "trajectories");

  async function ensure() {
    await mkdir(trajectoryDir, { recursive: true, mode: 0o700 });
  }

  async function append(input) {
    await ensure();
    const createdAt = input.createdAt || new Date().toISOString();
    const trajectory = validateTrajectory({
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      trajectoryId: asString(input.trajectoryId) || randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      projectId: asString(input.projectId),
      workspaceId: input.workspaceId,
      episodeIndex: input.episodeIndex,
      generation: input.generation,
      stateKey: input.stateKey,
      state: input.state,
      actionId: input.actionId,
      actionMode: asString(input.actionMode) || "unknown",
      policyVersion: input.policyVersion,
      candidateId: asString(input.candidateId),
      candidateKey: input.candidateKey,
      parentKey: input.parentKey === null ? null : asString(input.parentKey),
      experimentId: asString(input.experimentId),
      candidateSpecHash: asString(input.candidateSpecHash),
      candidateMetadata: isRecord(input.candidateMetadata) ? input.candidateMetadata : {},
      status: asString(input.status) || "unknown",
      decision: asString(input.decision),
      score: Number.isFinite(input.score) ? input.score : null,
      reward: input.reward,
      rewardComponents: isRecord(input.rewardComponents) ? input.rewardComponents : {},
      metrics: isRecord(input.metrics) ? input.metrics : {},
      evidence: isRecord(input.evidence) ? input.evidence : {},
      nextState: input.nextState,
      isWinner: input.isWinner === true,
      createdAt,
    });
    const target = path.join(trajectoryDir, `${trajectory.trajectoryId}.json`);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(trajectory, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    return trajectory;
  }

  async function list(filter = {}) {
    await ensure();
    const names = (await readdir(trajectoryDir)).filter((name) => name.endsWith(".json")).sort();
    const values = [];
    for (const name of names) {
      try {
        const value = validateTrajectory(JSON.parse(await readFile(path.join(trajectoryDir, name), "utf8")));
        if (filter.workspaceId && value.workspaceId !== filter.workspaceId) continue;
        if (filter.stateKey && value.stateKey !== filter.stateKey) continue;
        if (filter.actionId && value.actionId !== filter.actionId) continue;
        values.push(value);
      } catch {
        // Ignore malformed files instead of poisoning the replay set.
      }
    }
    return values;
  }

  async function top(filter = {}, limit = 5) {
    const values = await list(filter);
    return values
      .sort((a, b) => (b.reward - a.reward) || Number(b.isWinner) - Number(a.isWinner) || a.trajectoryId.localeCompare(b.trajectoryId))
      .slice(0, Math.max(0, Math.min(50, Number(limit) || 5)));
  }

  async function stats(filter = {}) {
    const values = await list(filter);
    const meanReward = values.length ? values.reduce((sum, value) => sum + value.reward, 0) / values.length : 0;
    const winners = values.filter((value) => value.isWinner).length;
    const byAction = {};
    for (const value of values) {
      const entry = byAction[value.actionId] ?? { count: 0, rewardSum: 0, wins: 0 };
      entry.count += 1;
      entry.rewardSum += value.reward;
      entry.wins += value.isWinner ? 1 : 0;
      byAction[value.actionId] = entry;
    }
    return {
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      count: values.length,
      winners,
      meanReward,
      byAction: Object.fromEntries(Object.entries(byAction).map(([key, value]) => [key, {
        count: value.count,
        meanReward: value.count ? value.rewardSum / value.count : 0,
        wins: value.wins,
      }])),
    };
  }

  return { rootDir, trajectoryDir, append, list, top, stats };
}
