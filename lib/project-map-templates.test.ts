import { describe, expect, it } from "vitest";
import { normalizeProjectMap } from "@/lib/project-map";
import {
  BENCHFLOW_SKILL_LIFT_NODE_TITLES,
  createBenchFlowSkillLiftProjectMap,
  createProjectMapForTitle,
} from "@/lib/project-map-templates";

describe("project map templates", () => {
  it("selects the BenchFlow Skill Lift template from relevant project titles", () => {
    for (const title of [
      "BenchFlow — Agent Skill Lift",
      "Skill Lift submission",
      "SkillsBench experiments",
    ]) {
      const map = createProjectMapForTitle(title);
      expect(map.nodes.map((node) => node.title)).toEqual(BENCHFLOW_SKILL_LIFT_NODE_TITLES);
    }
  });

  it("builds an acyclic BenchFlow workflow that converges experiments into evaluation", () => {
    const map = normalizeProjectMap(createBenchFlowSkillLiftProjectMap());
    expect(map.nodes).toHaveLength(BENCHFLOW_SKILL_LIFT_NODE_TITLES.length);
    expect(map.edges.length).toBeGreaterThan(0);

    const pairedEvaluation = map.nodes.find((node) => node.title === "Paired Lift Evaluation");
    expect(pairedEvaluation).toBeTruthy();

    const experimentSources = new Set(
      map.edges
        .filter((edge) => edge.targetNodeId === pairedEvaluation?.id)
        .map((edge) => map.nodes.find((node) => node.id === edge.sourceNodeId)?.title),
    );

    expect(experimentSources).toEqual(new Set([
      "Capability Skill Experiments",
      "Safety Skill Experiments",
      "Generalization Skill Experiments",
    ]));
  });

  it("makes Tycho's empirical loop explicit in the competition workflow", () => {
    const map = createBenchFlowSkillLiftProjectMap();
    const titles = map.nodes.map((node) => node.title);

    expect(titles).toContain("Tycho Observation Protocol");
    expect(titles).toContain("Tycho Skill Hypothesis Model");
    expect(titles).toContain("Tycho Falsification & Regression Gate");
    expect(titles).toContain("Skill Revision & Selection");

    const hypothesisNode = map.nodes.find((node) => node.title === "Tycho Skill Hypothesis Model");
    expect(hypothesisNode?.description).toContain("falsifiable");
    expect(hypothesisNode?.description).toContain("Benchmark evidence remains authoritative");
  });

  it("ends only after both the frozen ZIP and writeup feed the final submission", () => {
    const map = createBenchFlowSkillLiftProjectMap();
    const finalNode = map.nodes.find((node) => node.title === "Final Kaggle Submission");
    expect(finalNode).toBeTruthy();

    const incomingTitles = new Set(
      map.edges
        .filter((edge) => edge.targetNodeId === finalNode?.id)
        .map((edge) => map.nodes.find((node) => node.id === edge.sourceNodeId)?.title),
    );

    expect(incomingTitles).toEqual(new Set(["Build submission.zip", "Kaggle Writeup"]));
  });
});
