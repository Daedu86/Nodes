import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexEvolutionVariantPrompt,
  parseCodexEvolutionVariantOutput,
} from "./codex-evolution-generator.mjs";

const protocol = (experimentId) => ({ schemaVersion: 1, experimentId, objective: "test" });

const validOutput = JSON.stringify({
  variants: [
    {
      id: "a",
      spec: { experimentId: "exp-a", protocol: protocol("exp-a") },
      metadata: { hypothesis: "A" },
    },
    {
      id: "b",
      spec: { experimentId: "exp-b", protocol: protocol("exp-b"), workspaceFiles: [{ path: "candidate.txt", content: "b" }] },
      metadata: { hypothesis: "B" },
    },
  ],
});

test("runner-side variant parser enforces exact count and protocol identity", () => {
  const variants = parseCodexEvolutionVariantOutput(validOutput, 2);
  assert.deepEqual(variants.map((variant) => variant.id), ["a", "b"]);
  assert.throws(() => parseCodexEvolutionVariantOutput(validOutput, 1), /expected exactly 1/);
  assert.throws(() => parseCodexEvolutionVariantOutput(JSON.stringify({
    variants: [{ id: "x", spec: { experimentId: "x", protocol: protocol("other") } }],
  }), 1), /must match/);
});

test("runner-side variant parser rejects reserved protocol overwrite and traversal", () => {
  assert.throws(() => parseCodexEvolutionVariantOutput(JSON.stringify({
    variants: [{
      id: "x",
      spec: {
        experimentId: "x",
        protocol: protocol("x"),
        workspaceFiles: [{ path: ".nodes/tycho-experiment.json", content: "{}" }],
      },
    }],
  }), 1), /must not override/);
  assert.throws(() => parseCodexEvolutionVariantOutput(JSON.stringify({
    variants: [{
      id: "x",
      spec: {
        experimentId: "x",
        protocol: protocol("x"),
        workspaceFiles: [{ path: "../escape", content: "x" }],
      },
    }],
  }), 1), /must not traverse/);
});

test("runner-side prompt carries parent reward while declaring hypothesis-only boundary", () => {
  const prompt = buildCodexEvolutionVariantPrompt({
    count: 2,
    generation: 3,
    parent: {
      id: "winner",
      key: "g2:winner",
      generation: 2,
      parentKey: "g1:parent",
      spec: { experimentId: "winner-exp", protocol: protocol("winner-exp") },
    },
    parentEvaluation: { score: 2.5, metrics: { passRatio: 1 }, evidence: { decision: "promote" } },
  });
  assert.match(prompt, /Generate exactly 2 distinct variants for generation 3/);
  assert.match(prompt, /Do not use tools, shell commands, files, network access, child agents, or side effects/);
  assert.match(prompt, /"score": 2.5/);
  assert.match(prompt, /g2:winner/);
});
