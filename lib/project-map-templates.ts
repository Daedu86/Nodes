import {
  PROJECT_MAP_VERSION,
  type ProjectMap,
  type ProjectMapEdge,
  type ProjectMapNode,
} from "@/lib/project-map";

export const TITANIC_PROJECT_NODE_TITLES = [
  "Problem Definition",
  "Dataset Acquisition",
  "Dataset Inspection",
  "Missing Values Analysis",
  "Target Analysis — Survived",
  "Passenger Class Analysis",
  "Sex Analysis",
  "Age Analysis",
  "Fare Analysis",
  "Embarked Analysis",
  "Family Relationships",
  "Cabin Analysis",
  "Ticket Analysis",
  "Data Cleaning",
  "Missing-value Imputation",
  "Categorical Encoding",
  "Feature Engineering",
  "Feature Selection",
  "Train / Validation Strategy",
  "Baseline Model",
  "Logistic Regression",
  "Decision Tree",
  "Random Forest",
  "Gradient Boosting",
  "XGBoost / Boosted Trees",
  "KNN",
  "SVM",
  "Model Evaluation",
  "Cross Validation",
  "Hyperparameter Tuning",
  "Feature Importance",
  "Error Analysis",
  "Model Comparison",
  "Final Model",
  "Test-set Prediction",
  "Kaggle Submission",
] as const;

export const BENCHFLOW_SKILL_LIFT_NODE_TITLES = [
  "Competition Definition & Track Strategy",
  "Reproduce BenchFlow Harness",
  "Tycho Observation Protocol",
  "No-Skill Baseline",
  "Evidence Ledger & Failure Taxonomy",
  "Tycho Skill Hypothesis Model",
  "Skill Architecture",
  "Capability Skill Experiments",
  "Safety Skill Experiments",
  "Generalization Skill Experiments",
  "Paired Lift Evaluation",
  "Tycho Falsification & Regression Gate",
  "Skill Revision & Selection",
  "Final Holdout Simulation",
  "Freeze Skill Library",
  "Compliance & Safety Preflight",
  "Build submission.zip",
  "Kaggle Writeup",
  "Final Kaggle Submission",
] as const;

type BenchFlowSkillLiftNodeTitle = (typeof BENCHFLOW_SKILL_LIFT_NODE_TITLES)[number];

const BENCHFLOW_SKILL_LIFT_DESCRIPTIONS: Record<BenchFlowSkillLiftNodeTitle, string> = {
  "Competition Definition & Track Strategy":
    "Capture the Skill Lift rules, scoring weights, submission constraints, deadline, and chosen track. Output a concise project contract that defines what counts as success and what must never be optimized away.",
  "Reproduce BenchFlow Harness":
    "Reproduce the public SkillsBench/BenchFlow task scaffold and verifier flow locally. Record exact setup commands, versions, fixtures, and a minimal passing smoke test so every later experiment is reproducible.",
  "Tycho Observation Protocol":
    "Adapt Tycho's observe-model-act-revise method to skill evaluation. Define exactly which evidence each run must preserve: task instruction, environment state, agent actions, tool results, verifier outcome, safety events, token/cost budget, and artifacts.",
  "No-Skill Baseline":
    "Run representative public tasks without the candidate skill set under the fixed observation protocol. Preserve raw traces and aggregate results; publish baseline-results.json and a short baseline summary downstream.",
  "Evidence Ledger & Failure Taxonomy":
    "Turn baseline traces into durable evidence. Classify failures by root cause such as task misunderstanding, missing procedure, unsafe action, tool misuse, weak verification, recovery failure, or domain-specific knowledge gap. Do not infer beyond recorded evidence.",
  "Tycho Skill Hypothesis Model":
    "Create an advisory, falsifiable model of the expected skill intervention. For each proposed skill record trigger, procedure, predicted benefit, possible regressions, safety boundary, observable success signals, and tests that would falsify the hypothesis. Benchmark evidence remains authoritative.",
  "Skill Architecture":
    "Translate surviving hypotheses into a small reusable skill system. Define skill boundaries, trigger descriptions, shared conventions, optional scripts/references, token budget, and composition rules while avoiding public-task lookup behavior.",
  "Capability Skill Experiments":
    "Implement and test skills intended to improve task completion, tool use, planning, recovery, and verification. Run multiple sessions when useful and publish only evidence-backed candidate outputs for paired evaluation.",
  "Safety Skill Experiments":
    "Implement and test safety boundaries for destructive actions, confidentiality, authorization, permission changes, scope control, and irreversible operations. Prefer fail-closed behavior where uncertainty could create a ClawsBench-style violation.",
  "Generalization Skill Experiments":
    "Test whether the skill procedures transfer across unrelated public domains and task shapes. Remove benchmark-specific wording, identifiers, and brittle assumptions; preserve only abstractions supported across multiple tasks.",
  "Paired Lift Evaluation":
    "Evaluate the same task/model conditions with and without the candidate skill set. Record paired score deltas, per-domain behavior, variance, failures, and safety outcomes so changes can be attributed to the skills rather than the model or harness.",
  "Tycho Falsification & Regression Gate":
    "Actively search for evidence that the skill hypothesis is wrong. Inspect regressions, unsafe actions, over-triggering, under-triggering, unnecessary token/tool usage, and cases where direct reasoning beats the skill. Reject or constrain skills that fail the gate.",
  "Skill Revision & Selection":
    "Revise skills from falsification evidence, compare candidate variants, and select the smallest set with repeatable positive lift and acceptable safety/generalization behavior. Preserve rejected variants and reasons as experiment artifacts, not final submission content.",
  "Final Holdout Simulation":
    "Run a final public holdout-style evaluation using tasks or domains not used to author the last revision. Freeze prompts/configuration before the run and treat the result as a generalization check rather than another tuning opportunity.",
  "Freeze Skill Library":
    "Freeze the exact skills/ directory that will be submitted. Record a manifest or hashes, final file tree, skill descriptions, and provenance so the writeup and ZIP refer to one immutable candidate library.",
  "Compliance & Safety Preflight":
    "Audit the frozen library for injection, exfiltration, sandbox escape, unauthorized permission escalation, destructive defaults, excessive length, secret leakage, and competition-rule violations. Block packaging if a critical issue remains.",
  "Build submission.zip":
    "Package the frozen library using the required submission.zip/skills/<skill-name>/SKILL.md structure with optional scripts/ and references/. Verify the archive contents and attach the final ZIP artifact to this node.",
  "Kaggle Writeup":
    "Write the reproducible competition report from project evidence: design rationale, Tycho-inspired empirical loop, public evaluation, regressions, safety strategy, generalization strategy, and exact reproduction steps. Keep it within the competition word limit.",
  "Final Kaggle Submission":
    "Perform the final submission checklist: correct track, frozen ZIP attached, writeup submitted rather than draft, reproducibility evidence linked, compliance gate passed, and final submission status recorded as the terminal project artifact.",
};

const toNodeId = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workload";

const createNode = (title: string, description: string): ProjectMapNode => ({
  description,
  id: toNodeId(title),
  primarySessionId: null,
  selectedOutput: null,
  sessionIds: [],
  status: "planned",
  title,
});

const edge = (sourceTitle: string, targetTitle: string, label: string | null = null): ProjectMapEdge => ({
  id: `${toNodeId(sourceTitle)}=>${toNodeId(targetTitle)}`,
  label,
  sourceNodeId: toNodeId(sourceTitle),
  targetNodeId: toNodeId(targetTitle),
});

export const createDefaultProjectMap = (title: string | null = null): ProjectMap => ({
  edges: [],
  nodes: [
    createNode(
      "Project Setup",
      `Define the objective, constraints, inputs, expected outputs, and first executable workload for ${title?.trim() || "this project"}.`,
    ),
  ],
  version: PROJECT_MAP_VERSION,
});

export const createTitanicProjectMap = (): ProjectMap => {
  const nodes = TITANIC_PROJECT_NODE_TITLES.map((title) =>
    createNode(title, `Titanic ML workload: ${title}. Open this node to run one or more sessions and publish a selected result downstream.`),
  );

  const analysisTitles = [
    "Missing Values Analysis",
    "Target Analysis — Survived",
    "Passenger Class Analysis",
    "Sex Analysis",
    "Age Analysis",
    "Fare Analysis",
    "Embarked Analysis",
    "Family Relationships",
    "Cabin Analysis",
    "Ticket Analysis",
  ] as const;
  const modelTitles = [
    "Logistic Regression",
    "Decision Tree",
    "Random Forest",
    "Gradient Boosting",
    "XGBoost / Boosted Trees",
    "KNN",
    "SVM",
  ] as const;

  const edges: ProjectMapEdge[] = [
    edge("Problem Definition", "Dataset Acquisition"),
    edge("Dataset Acquisition", "Dataset Inspection"),
    ...analysisTitles.map((title) => edge("Dataset Inspection", title, "inspect")),
    ...analysisTitles.map((title) => edge(title, "Data Cleaning", "analysis output")),
    edge("Data Cleaning", "Missing-value Imputation"),
    edge("Missing-value Imputation", "Categorical Encoding"),
    edge("Categorical Encoding", "Feature Engineering"),
    edge("Feature Engineering", "Feature Selection"),
    edge("Feature Selection", "Train / Validation Strategy"),
    edge("Train / Validation Strategy", "Baseline Model"),
    ...modelTitles.map((title) => edge("Baseline Model", title, "model experiment")),
    ...modelTitles.map((title) => edge(title, "Model Evaluation", "model result")),
    edge("Model Evaluation", "Cross Validation"),
    edge("Cross Validation", "Hyperparameter Tuning"),
    edge("Hyperparameter Tuning", "Feature Importance"),
    edge("Feature Importance", "Error Analysis"),
    edge("Error Analysis", "Model Comparison"),
    edge("Model Comparison", "Final Model"),
    edge("Final Model", "Test-set Prediction"),
    edge("Test-set Prediction", "Kaggle Submission"),
  ];

  return { edges, nodes, version: PROJECT_MAP_VERSION };
};

export const createBenchFlowSkillLiftProjectMap = (): ProjectMap => {
  const nodes = BENCHFLOW_SKILL_LIFT_NODE_TITLES.map((title) =>
    createNode(title, BENCHFLOW_SKILL_LIFT_DESCRIPTIONS[title]),
  );

  const experimentTitles = [
    "Capability Skill Experiments",
    "Safety Skill Experiments",
    "Generalization Skill Experiments",
  ] as const;

  const edges: ProjectMapEdge[] = [
    edge("Competition Definition & Track Strategy", "Reproduce BenchFlow Harness"),
    edge("Reproduce BenchFlow Harness", "Tycho Observation Protocol", "reproducible environment"),
    edge("Tycho Observation Protocol", "No-Skill Baseline", "evidence contract"),
    edge("No-Skill Baseline", "Evidence Ledger & Failure Taxonomy", "observations"),
    edge("Evidence Ledger & Failure Taxonomy", "Tycho Skill Hypothesis Model", "failure evidence"),
    edge("Tycho Skill Hypothesis Model", "Skill Architecture", "falsifiable hypotheses"),
    ...experimentTitles.map((title) => edge("Skill Architecture", title, "candidate skills")),
    ...experimentTitles.map((title) => edge(title, "Paired Lift Evaluation", "experiment evidence")),
    edge("Paired Lift Evaluation", "Tycho Falsification & Regression Gate", "paired results"),
    edge("Tycho Falsification & Regression Gate", "Skill Revision & Selection", "surviving evidence"),
    edge("Skill Revision & Selection", "Final Holdout Simulation", "selected library"),
    edge("Final Holdout Simulation", "Freeze Skill Library", "holdout evidence"),
    edge("Freeze Skill Library", "Compliance & Safety Preflight", "frozen candidate"),
    edge("Compliance & Safety Preflight", "Build submission.zip", "approved library"),
    edge("Freeze Skill Library", "Kaggle Writeup", "final design + evidence"),
    edge("Final Holdout Simulation", "Kaggle Writeup", "evaluation evidence"),
    edge("Build submission.zip", "Final Kaggle Submission", "submission artifact"),
    edge("Kaggle Writeup", "Final Kaggle Submission", "writeup"),
  ];

  return { edges, nodes, version: PROJECT_MAP_VERSION };
};

export const createProjectMapForTitle = (title: string | null = null): ProjectMap => {
  const normalizedTitle = title?.trim() || "";
  if (/(?:bench\s*flow|skill[\s-]*lift|skillsbench)/i.test(normalizedTitle)) {
    return createBenchFlowSkillLiftProjectMap();
  }
  if (/\btitanic\b/i.test(normalizedTitle)) {
    return createTitanicProjectMap();
  }
  return createDefaultProjectMap(title);
};
