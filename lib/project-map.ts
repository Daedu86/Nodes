export type ProjectMapNode = {
  id: string;
  index: number;
  title: string;
};

const normalizeNodeTitle = (value: string) =>
  value
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|[├└]──\s*)/, "")
    .replace(/^\d+[.)]\s*/, "")
    .trim();

const toNodeId = (index: number, title: string) => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${index + 1}-${slug || "node"}`;
};

export function parseProjectMapNodes(markdown: string): ProjectMapNode[] {
  const lines = markdown.split(/\r?\n/);
  const nodes: ProjectMapNode[] = [];
  let inNodesSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^##\s+nodes\b/i.test(trimmed)) {
      inNodesSection = true;
      continue;
    }

    if (inNodesSection && /^##\s+/.test(trimmed)) {
      break;
    }

    if (!inNodesSection) continue;

    const headingMatch = trimmed.match(/^###\s+(.+)$/);
    const listMatch = trimmed.match(/^(?:[-*+]\s+|\d+[.)]\s+|[├└]──\s*)(.+)$/);
    const rawTitle = headingMatch?.[1] ?? listMatch?.[1] ?? null;
    if (!rawTitle) continue;

    const title = normalizeNodeTitle(rawTitle);
    if (!title || /^add and connect project nodes here/i.test(title)) continue;

    nodes.push({
      id: toNodeId(nodes.length, title),
      index: nodes.length,
      title,
    });
  }

  return nodes;
}

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

export function createTitanicProjectMap(title: string) {
  return [
    `# ${title} — Project Map`,
    "",
    "> Base document: this map is the canonical index of the project.",
    "",
    "## Project rule",
    "",
    "- Every project has exactly one base map.",
    "- Each map node is a thinking/workload unit and may contain multiple sessions or runs.",
    "- Node outputs can feed downstream nodes in the project map.",
    "- Sessions are execution history; the map is the project structure and index.",
    "",
    "## Nodes",
    "",
    ...TITANIC_PROJECT_NODE_TITLES.map((nodeTitle, index) => `${index + 1}. ${nodeTitle}`),
  ].join("\n");
}
