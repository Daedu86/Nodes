import { describe, expect, it } from "vitest";
import {
  buildCodexEvolutionVariantPrompt,
  parseCodexEvolutionVariantOutput,
} from "../lib/tycho/codex-evolution-variant-contract";

const variant = (id: string, experimentId = `experiment-${id}`) => ({
  id,
  spec: {
    experimentId,
    protocol: {
      schemaVersion: 1,
      experimentId,
      objective: "test candidate",
    },
    workspaceFiles: [
      { path: `candidates/${id}.txt`, content: id, mimeType: "text/plain" },
    ],
  },
  metadata: { hypothesis: `hypothesis-${id}` },
});

describe("Codex evolution variant contract", () => {
  it("accepts an exact, valid candidate population", () => {
    const result = parseCodexEvolutionVariantOutput(
      JSON.stringify({ variants: [variant("a"), variant("b")] }),
      2,
    );

    expect(result).toHaveLength(2);
    expect(result[0]?.spec.protocol).toMatchObject({
      schemaVersion: 1,
      experimentId: "experiment-a",
    });
    expect(result[1]?.spec.workspaceFiles?.[0]?.path).toBe("candidates/b.txt");
  });

  it("rejects prose or malformed JSON instead of guessing", () => {
    expect(() => parseCodexEvolutionVariantOutput("```json\n{}\n```", 1)).toThrow(
      "invalid JSON",
    );
  });

  it("requires exactly the requested population size", () => {
    expect(() =>
      parseCodexEvolutionVariantOutput(JSON.stringify({ variants: [variant("a")] }), 2),
    ).toThrow("expected exactly 2");
  });

  it("rejects duplicate candidate ids", () => {
    expect(() =>
      parseCodexEvolutionVariantOutput(
        JSON.stringify({ variants: [variant("same", "experiment-a"), variant("same", "experiment-b")] }),
        2,
      ),
    ).toThrow("duplicate variant id");
  });

  it("rejects protocol identity mismatches", () => {
    const invalid = variant("a");
    invalid.spec.protocol.experimentId = "different";
    expect(() =>
      parseCodexEvolutionVariantOutput(JSON.stringify({ variants: [invalid] }), 1),
    ).toThrow("protocol experimentId must match");
  });

  it("rejects reserved, absolute, and parent-traversing workspace paths", () => {
    for (const path of [
      ".nodes/tycho-experiment.json",
      "/tmp/candidate.txt",
      "../candidate.txt",
      "C:/candidate.txt",
    ]) {
      const invalid = variant("a");
      invalid.spec.workspaceFiles[0]!.path = path;
      expect(() =>
        parseCodexEvolutionVariantOutput(JSON.stringify({ variants: [invalid] }), 1),
      ).toThrow();
    }
  });

  it("puts prior reward evidence into the next Codex prompt as data", () => {
    const prompt = buildCodexEvolutionVariantPrompt({
      count: 3,
      generation: 2,
      parent: {
        id: "winner",
        key: "g1:winner",
        generation: 1,
        parentKey: "g0:seed",
        spec: {
          experimentId: "winner-experiment",
          protocol: { schemaVersion: 1, experimentId: "winner-experiment" },
        },
      },
      parentEvaluation: {
        score: 2.45,
        metrics: { passRatio: 0.9 },
        evidence: { decision: "promote" },
      },
    });

    expect(prompt).toContain("Generate exactly 3 distinct variants for generation 2");
    expect(prompt).toContain('"score": 2.45');
    expect(prompt).toContain('"passRatio": 0.9');
    expect(prompt).toContain('"decision": "promote"');
    expect(prompt).toContain("untrusted experiment data");
  });
});
