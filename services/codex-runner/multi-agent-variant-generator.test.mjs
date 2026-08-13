import assert from "node:assert/strict";
import test from "node:test";

import { createMultiAgentVariantGenerator } from "./multi-agent-variant-generator.mjs";

function fakePolicy(topologyId) {
  return {
    mode: "observe",
    select: async ({ stateKey, strategyActionId }) => ({
      contextKey: `${stateKey}|strategy=${strategyActionId}`,
      topology: { id: topologyId, description: topologyId },
      mode: "exploit",
      teamPolicyVersion: "t0",
      value: 0,
      epsilon: 0,
    }),
  };
}

function fakeGenerator(calls) {
  let run = 0;
  return async (input) => {
    run += 1;
    calls.push({ count: input.count, parentEvaluation: input.parentEvaluation });
    const profileId = input.parentEvaluation?.evidence?.multiAgentAgent?.profileId || "unknown";
    return {
      generatorRunId: `run-${run}`,
      variants: Array.from({ length: input.count }, (_, index) => ({
        id: `${profileId}-${run}-${index}`,
        spec: {
          experimentId: `exp-${run}-${index}`,
          protocol: { schemaVersion: 1, experimentId: `exp-${run}-${index}` },
        },
        metadata: { hypothesis: `${profileId}-${index}` },
      })),
    };
  };
}

const baseInput = {
  count: 4,
  generation: 1,
  sessionId: "session",
  workspaceId: "workspace",
  parent: { id: "seed", key: "g0:seed", generation: 0, spec: {} },
  parentEvaluation: { score: 0, metrics: {}, evidence: {} },
  stateKey: "state",
  strategyActionId: "diversify",
  seedKey: "seed-key",
};

test("parallel specialists split population exactly across independent agents", async () => {
  const calls = [];
  const generator = createMultiAgentVariantGenerator({ baseGenerator: fakeGenerator(calls), teamPolicyController: fakePolicy("parallel-specialists") });
  const result = await generator.generate(baseInput);
  assert.equal(result.variants.length, 4);
  assert.deepEqual(calls.map((call) => call.count), [2, 1, 1]);
  assert.deepEqual(calls.map((call) => call.parentEvaluation.evidence.multiAgentAgent.profileId), ["failure-analyst", "mechanism-explorer", "falsifier"]);
  assert.equal(result.variants.every((variant) => variant.metadata.multiAgentTeam.topologyId === "parallel-specialists"), true);
});

test("proposer critic feeds proposal evidence into the second agent", async () => {
  const calls = [];
  const generator = createMultiAgentVariantGenerator({ baseGenerator: fakeGenerator(calls), teamPolicyController: fakePolicy("proposer-critic") });
  const result = await generator.generate({ ...baseInput, count: 2 });
  assert.equal(result.variants.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].parentEvaluation.evidence.multiAgentAgent.profileId, "proposer");
  assert.equal(calls[1].parentEvaluation.evidence.multiAgentAgent.profileId, "critic");
  assert.equal(calls[1].parentEvaluation.evidence.multiAgentTeamContext.proposals.length, 2);
  assert.equal(result.variants.every((variant) => variant.metadata.multiAgentContribution.profileId === "critic"), true);
});

test("debate gives both stances to a synthesizer and returns only synthesis variants", async () => {
  const calls = [];
  const generator = createMultiAgentVariantGenerator({ baseGenerator: fakeGenerator(calls), teamPolicyController: fakePolicy("debate") });
  const result = await generator.generate({ ...baseInput, count: 2 });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.parentEvaluation.evidence.multiAgentAgent.profileId), ["conservative", "radical", "synthesizer"]);
  const context = calls[2].parentEvaluation.evidence.multiAgentTeamContext;
  assert.equal(context.conservative.length, 2);
  assert.equal(context.radical.length, 2);
  assert.equal(result.variants.length, 2);
  assert.equal(result.variants.every((variant) => variant.metadata.multiAgentContribution.profileId === "synthesizer"), true);
});
