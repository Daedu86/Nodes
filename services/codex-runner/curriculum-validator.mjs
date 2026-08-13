const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function stringArray(value, field, max = 12) {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new Error(`Curriculum ${field} must contain 1-${max} strings.`);
  const normalized = value.map((item) => asString(item));
  if (normalized.some((item) => !item)) throw new Error(`Curriculum ${field} must contain only non-empty strings.`);
  return normalized;
}

export function parseAllowedCurriculumDomains(value = process.env.TYCHO_CURRICULUM_ALLOWED_DOMAINS) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function validateCurriculumTask(task, options = {}) {
  if (!isRecord(task) || task.schemaVersion !== 1) throw new Error("Curriculum task schemaVersion must equal 1.");
  for (const field of ["taskId", "domain", "capabilityKey", "objective"]) {
    if (!asString(task[field])) throw new Error(`Curriculum task ${field} is required.`);
  }
  if (!Number.isFinite(task.difficulty) || task.difficulty < 0 || task.difficulty > 1) throw new Error("Curriculum task difficulty must be between 0 and 1.");
  const maxDifficulty = Number(options.maxDifficulty ?? process.env.TYCHO_CURRICULUM_MAX_DIFFICULTY ?? 0.85);
  if (task.difficulty > maxDifficulty) throw new Error(`Curriculum task difficulty ${task.difficulty} exceeds max ${maxDifficulty}.`);
  const allowedDomains = Array.isArray(options.allowedDomains) ? options.allowedDomains : parseAllowedCurriculumDomains();
  if (allowedDomains.length && !allowedDomains.includes(task.domain)) throw new Error(`Curriculum task domain is not allowed: ${task.domain}.`);
  const constraints = stringArray(task.constraints, "constraints");
  const successCriteria = stringArray(task.successCriteria, "successCriteria");
  if (!isRecord(task.reason) || !isRecord(task.budget)) throw new Error("Curriculum task reason and budget are required.");
  if (!Number.isInteger(task.budget.generation) || task.budget.generation <= 0) throw new Error("Curriculum task budget.generation must be positive.");
  if (!Number.isInteger(task.budget.maxTasksPerRun) || task.budget.maxTasksPerRun <= 0) throw new Error("Curriculum task budget.maxTasksPerRun must be positive.");
  if (task.budget.generation > task.budget.maxTasksPerRun) throw new Error("Curriculum task exceeds maxTasksPerRun.");
  return { ...task, constraints, successCriteria };
}
