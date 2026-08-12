import { describe, expect, it } from "vitest";

import { buildProjectExecutionPrompt } from "@/lib/agents/codex/project-execution-context";

const base = {
  projectId: "project-1",
  projectTitle: "Titanic",
  workloadTitle: "Iteration 18",
  workloadDescription: "Test one candidate.",
  upstreamSummary: "Iteration 4 is champion.",
  artifacts: [],
};

describe("buildProjectExecutionPrompt", () => {
  it("keeps direct execution as an explicit policy", () => {
    const prompt = buildProjectExecutionPrompt({ ...base, mode: "direct" });
    expect(prompt).toContain("Execution policy: direct Luna/Codex workload execution.");
    expect(prompt).not.toContain("tycho-experiment --workspace");
  });

  it("adds the falsifiable Tycho promotion gate", () => {
    const prompt = buildProjectExecutionPrompt({ ...base, mode: "tycho" });
    expect(prompt).toContain("Tycho empirical harness with Luna/Codex as the actor");
    expect(prompt).toContain("tycho-experiment --workspace . --protocol .nodes/tycho-experiment.json");
    expect(prompt).toContain('decision == "promote"');
    expect(prompt).toContain("do not use hidden/derived test labels");
    expect(prompt).toContain("at most one evidence-driven revision");
  });
});
