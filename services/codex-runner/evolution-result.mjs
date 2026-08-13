import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export const TYCHO_RESULT_PATH = ".nodes/tycho-result.json";
const MAX_RESULT_BYTES = 1_000_000;
const DECISIONS = new Set(["promote", "reject", "blocked"]);
const ISOLATED_RUNTIMES = new Set(["docker", "finch", "kubernetes"]);

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const asCount = (value, field) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Tycho result ${field} must be a non-negative integer.`);
  }
  return value;
};

export function parseTychoEvolutionResult(value, expectedExperimentId = null) {
  if (!isRecord(value)) throw new Error("Tycho result must be a JSON object.");
  if (value.schemaVersion !== 1) throw new Error("Tycho result schemaVersion must equal 1.");

  const experimentId = asString(value.experimentId);
  if (!experimentId) throw new Error("Tycho result experimentId is missing.");
  if (expectedExperimentId && experimentId !== expectedExperimentId) {
    throw new Error(
      `Tycho result experimentId mismatch: expected ${expectedExperimentId}, received ${experimentId}.`,
    );
  }

  const decision = asString(value.decision);
  if (!decision || !DECISIONS.has(decision)) {
    throw new Error(`Tycho result decision is invalid: ${decision ?? "missing"}.`);
  }

  if (!isRecord(value.summary)) throw new Error("Tycho result summary must be an object.");
  const stepCount = asCount(value.summary.stepCount, "summary.stepCount");
  const executedSteps = asCount(value.summary.executedSteps, "summary.executedSteps");
  const passedSteps = asCount(value.summary.passedSteps, "summary.passedSteps");
  const failedSteps = asCount(value.summary.failedSteps, "summary.failedSteps");
  const blockedSteps = asCount(value.summary.blockedSteps, "summary.blockedSteps");
  if (executedSteps > stepCount) throw new Error("Tycho result executedSteps exceeds stepCount.");
  if (passedSteps + failedSteps + blockedSteps !== executedSteps) {
    throw new Error("Tycho result step counters do not add up to executedSteps.");
  }

  if (!isRecord(value.sandbox)) throw new Error("Tycho result sandbox must be an object.");
  const runtime = asString(value.sandbox.runtime);
  if (!runtime || !ISOLATED_RUNTIMES.has(runtime)) {
    throw new Error(`Tycho result must come from an isolated runtime, received ${runtime ?? "missing"}.`);
  }

  if (!Array.isArray(value.steps)) throw new Error("Tycho result steps must be an array.");
  if (value.steps.length !== executedSteps) {
    throw new Error("Tycho result steps length does not match executedSteps.");
  }

  return value;
}

export function readTychoEvolutionResult(cwd, expectedExperimentId = null) {
  const root = path.resolve(cwd);
  const target = path.resolve(root, TYCHO_RESULT_PATH);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Tycho result path escaped the evolution workspace.");
  }
  if (!existsSync(target)) throw new Error("Tycho result file was not produced.");

  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Tycho result path is not a regular file.");
  }
  if (stat.size > MAX_RESULT_BYTES) {
    throw new Error("Tycho result exceeds the runner result-size budget.");
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse Tycho result JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseTychoEvolutionResult(parsed, expectedExperimentId);
}
