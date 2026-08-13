const asString = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const asArray = (value) => (Array.isArray(value) ? value : []);

const reasoningEffortFrom = (value) => {
  if (typeof value === "string") return asString(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return asString(value.reasoningEffort) || asString(value.effort);
};

export function normalizeCodexModelCatalog(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (Array.isArray(raw.data) ? raw.data : Array.isArray(raw.models) ? raw.models : [])
    : [];

  const seen = new Set();
  const models = [];
  for (const entry of source) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const model = asString(entry.model) || asString(entry.id) || asString(entry.slug);
    if (!model || seen.has(model)) continue;
    seen.add(model);

    const supportedReasoningEfforts = [];
    for (const candidate of asArray(entry.supportedReasoningEfforts ?? entry.supported_reasoning_efforts)) {
      const effort = reasoningEffortFrom(candidate);
      if (effort && !supportedReasoningEfforts.includes(effort)) supportedReasoningEfforts.push(effort);
    }

    const defaultReasoningEffort =
      reasoningEffortFrom(entry.defaultReasoningEffort ?? entry.default_reasoning_effort) ||
      null;

    models.push({
      model,
      displayName: asString(entry.displayName) || asString(entry.display_name) || model,
      supportedReasoningEfforts,
      defaultReasoningEffort,
    });
  }
  return models;
}

export function withConfiguredFallbackModel(
  catalog,
  configuredModel,
  configuredReasoningEffort,
) {
  const model = asString(configuredModel);
  if (!model) return [...catalog];
  if (catalog.some((entry) => entry.model === model)) return [...catalog];
  const effort = asString(configuredReasoningEffort);
  return [
    ...catalog,
    {
      model,
      displayName: model,
      supportedReasoningEfforts: effort ? [effort] : [],
      defaultReasoningEffort: effort,
    },
  ];
}

export function resolveCodexExecutionProfile({
  catalog,
  requestedModel,
  requestedReasoningEffort,
  defaultModel,
  defaultReasoningEffort,
}) {
  const model = asString(requestedModel) || asString(defaultModel);
  if (!model) throw new Error("No Codex model is configured for this runner.");

  const modelEntry = catalog.find((entry) => entry.model === model);
  if (!modelEntry) {
    throw new Error(`Codex model is not allowed by the connected runner catalog: ${model}`);
  }

  const requestedEffort = asString(requestedReasoningEffort);
  const configuredEffort = asString(defaultReasoningEffort);
  const supported = modelEntry.supportedReasoningEfforts;
  const effort =
    requestedEffort ||
    (configuredEffort && supported.includes(configuredEffort) ? configuredEffort : null) ||
    modelEntry.defaultReasoningEffort ||
    (supported.includes("medium") ? "medium" : supported[0] ?? null);

  if (requestedEffort && !supported.includes(requestedEffort)) {
    throw new Error(
      `Codex model ${model} does not support reasoning effort ${requestedEffort}; supported: ${supported.join(", ") || "none reported"}.`,
    );
  }
  if (effort && supported.length > 0 && !supported.includes(effort)) {
    throw new Error(
      `Configured reasoning effort ${effort} is not supported by Codex model ${model}.`,
    );
  }

  return { model, reasoningEffort: effort };
}
