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

export const createProjectMapForTitle = (title: string | null = null): ProjectMap =>
  /\btitanic\b/i.test(title?.trim() || "")
    ? createTitanicProjectMap()
    : createDefaultProjectMap(title);
