import {
  PROJECT_MAP_VERSION,
  type ProjectMap,
  type ProjectMapEdge,
  type ProjectMapNode,
} from "@/lib/project-map";

export type ProjectStarterTemplateId =
  | "product-discovery"
  | "research-synthesis"
  | "technical-design"
  | "writing";

export type ProjectStarterTemplate = {
  id: ProjectStarterTemplateId;
  title: string;
  description: string;
  create: () => ProjectMap;
};

const idFor = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

const node = (title: string, description: string): ProjectMapNode => ({
  id: idFor(title),
  title,
  description,
  nodeType: "workload",
  primarySessionId: null,
  selectedOutput: null,
  sessionIds: [],
  status: "planned",
  terminalResult: false,
  childProjectId: null,
});

const chain = (titles: readonly string[]): ProjectMapEdge[] =>
  titles.slice(1).map((title, index) => ({
    id: `${idFor(titles[index]!)}=>${idFor(title)}`,
    sourceNodeId: idFor(titles[index]!),
    targetNodeId: idFor(title),
    label: null,
  }));

const createLinearMap = (
  steps: ReadonlyArray<readonly [title: string, description: string]>,
): ProjectMap => ({
  version: PROJECT_MAP_VERSION,
  nodes: steps.map(([title, description]) => node(title, description)),
  edges: chain(steps.map(([title]) => title)),
});

export const createProductDiscoveryProjectMap = () => createLinearMap([
  ["Problem & Audience", "Define the user, problem, constraints, and measurable outcome."],
  ["Evidence & Alternatives", "Collect user evidence, current workarounds, competitors, and alternative explanations."],
  ["Solution Hypotheses", "Create falsifiable solution hypotheses and identify the riskiest assumptions."],
  ["Experiment", "Test the strongest alternatives with explicit success criteria and preserve evidence."],
  ["Decision", "Compare outcomes in Arena and record the selected direction plus rejected alternatives."],
] as const);

export const createResearchSynthesisProjectMap = () => createLinearMap([
  ["Research Question", "Define the question, scope, freshness requirements, and source-quality bar."],
  ["Source Collection", "Collect independent primary and high-quality secondary sources with provenance."],
  ["Evidence Extraction", "Extract claims, disagreements, limitations, and supporting evidence without synthesis drift."],
  ["Synthesis", "Compare explanations and produce a source-grounded synthesis."],
  ["Review & Decision", "Check gaps, uncertainty, citations, and preserve the reusable conclusion in project memory."],
] as const);

export const createTechnicalDesignProjectMap = () => createLinearMap([
  ["Requirements", "Capture functional requirements, constraints, security properties, SLOs, and non-goals."],
  ["Architecture Options", "Generate multiple architectures with explicit interfaces and trade-offs."],
  ["Prototype & Experiments", "Prototype risky components and measure performance, reliability, and operating cost."],
  ["Design Review", "Compare evidence in Arena and use gates for security, correctness, and maintainability."],
  ["Implementation Plan", "Freeze the selected design, migration stages, observability, rollback, and verification plan."],
] as const);

export const createWritingProjectMap = () => createLinearMap([
  ["Brief", "Define audience, purpose, constraints, voice, source material, and acceptance criteria."],
  ["Outline Alternatives", "Explore competing structures before committing to one narrative."],
  ["Draft", "Produce the selected draft while preserving factual/source boundaries."],
  ["Editorial Review", "Review clarity, evidence, consistency, accessibility, and audience fit."],
  ["Final", "Apply the winning revisions and preserve the final artifact plus key editorial decisions."],
] as const);

export const PROJECT_STARTER_TEMPLATES: readonly ProjectStarterTemplate[] = [
  {
    id: "product-discovery",
    title: "Product discovery",
    description: "Evidence-driven problem discovery, hypotheses, experiments, and decision.",
    create: createProductDiscoveryProjectMap,
  },
  {
    id: "research-synthesis",
    title: "Research synthesis",
    description: "Source collection, evidence extraction, synthesis, and review.",
    create: createResearchSynthesisProjectMap,
  },
  {
    id: "technical-design",
    title: "Technical design",
    description: "Requirements, architecture alternatives, prototypes, review, and implementation plan.",
    create: createTechnicalDesignProjectMap,
  },
  {
    id: "writing",
    title: "Writing",
    description: "Brief, alternative outlines, drafting, editorial review, and final artifact.",
    create: createWritingProjectMap,
  },
] as const;

export function getProjectStarterTemplate(id: ProjectStarterTemplateId) {
  return PROJECT_STARTER_TEMPLATES.find((template) => template.id === id) ?? null;
}
