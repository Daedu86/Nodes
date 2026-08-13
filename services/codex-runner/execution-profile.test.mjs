import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeCodexModelCatalog,
  resolveCodexExecutionProfile,
  withConfiguredFallbackModel,
} from "./execution-profile.mjs";

test("normalizes Codex model/list reasoning options in catalog order", () => {
  const catalog = normalizeCodexModelCatalog({
    data: [
      {
        model: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "max" },
        ],
        defaultReasoningEffort: "medium",
      },
    ],
  });
  assert.deepEqual(catalog, [
    {
      model: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      supportedReasoningEfforts: ["low", "medium", "max"],
      defaultReasoningEffort: "medium",
    },
  ]);
});

test("resolves a customer-selected Luna max profile", () => {
  const profile = resolveCodexExecutionProfile({
    catalog: [
      {
        model: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        defaultReasoningEffort: "medium",
      },
    ],
    requestedModel: "gpt-5.6-luna",
    requestedReasoningEffort: "max",
    defaultModel: "gpt-5.6-luna",
    defaultReasoningEffort: "medium",
  });
  assert.deepEqual(profile, { model: "gpt-5.6-luna", reasoningEffort: "max" });
});

test("rejects a reasoning effort not advertised by the selected model", () => {
  assert.throws(
    () =>
      resolveCodexExecutionProfile({
        catalog: [
          {
            model: "gpt-5.4-mini",
            displayName: "GPT-5.4 mini",
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
            defaultReasoningEffort: "medium",
          },
        ],
        requestedModel: "gpt-5.4-mini",
        requestedReasoningEffort: "max",
        defaultModel: "gpt-5.4-mini",
        defaultReasoningEffort: "medium",
      }),
    /does not support reasoning effort max/,
  );
});

test("fails closed on models outside the connected runner catalog", () => {
  assert.throws(
    () =>
      resolveCodexExecutionProfile({
        catalog: [],
        requestedModel: "arbitrary-host-model",
        requestedReasoningEffort: "medium",
        defaultModel: "gpt-5.6-luna",
        defaultReasoningEffort: "medium",
      }),
    /not allowed by the connected runner catalog/,
  );
});

test("keeps the configured runner model usable on older catalogs", () => {
  const catalog = withConfiguredFallbackModel([], "gpt-5.6-luna", "medium");
  assert.deepEqual(catalog, [
    {
      model: "gpt-5.6-luna",
      displayName: "gpt-5.6-luna",
      supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium",
    },
  ]);
});
