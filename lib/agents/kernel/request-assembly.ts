export type AgentPromptSectionContext = {
  runtime: string;
  sessionId: string;
  projectId: string | null;
  role: string | null;
  metadata: Readonly<Record<string, unknown>>;
};

export type AgentPromptSection = {
  name: string;
  order: number;
  text:
    | string
    | ((context: AgentPromptSectionContext) => string | null | undefined);
};

export type AgentRequestAssemblyInput = {
  runtime: string;
  sessionId: string;
  projectId?: string | null;
  role?: string | null;
  prompt: string;
  model?: string | null;
  reasoningEffort?: string | null;
  approvalMode?: string | null;
  sandboxPolicyId?: string | null;
  contextWindow?: number | null;
  workspacePaths?: readonly string[];
  toolNames?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
  sections?: readonly AgentPromptSection[];
};

export type AgentRequestHeader = {
  assemblyId: string;
  runtime: string;
  sessionId: string;
  projectId: string | null;
  role: string | null;
  model: string | null;
  reasoningEffort: string | null;
  approvalMode: string | null;
  sandboxPolicyId: string | null;
  contextWindow: number | null;
  workspacePaths: string[];
  toolNames: string[];
  sectionNames: string[];
};

export type AgentRequestAssembly = {
  header: AgentRequestHeader;
  systemPrompt: string;
  effectivePrompt: string;
};

export type AgentRequestAssemblerOptions = {
  createAssemblyId?: () => string;
};

const normalizedName = (value: string) => {
  const name = value.trim();
  if (!name) throw new Error("Agent prompt section name must not be empty.");
  return name;
};

const normalizedOrder = (value: number) => {
  if (!Number.isFinite(value)) {
    throw new Error("Agent prompt section order must be finite.");
  }
  return value;
};

const uniqueSorted = (values: readonly string[] | undefined) =>
  [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].sort();

const normalizedContextWindow = (value: number | null | undefined) => {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Agent request contextWindow must be a positive safe integer.");
  }
  return value;
};

/**
 * Provider-neutral request assembler. Global sections are registered once and
 * request-scoped sections may shadow them by name. The assembly always keeps
 * the original user prompt separate from the rendered system/context material,
 * while `effectivePrompt` preserves compatibility with runtimes that currently
 * accept only one prompt string.
 */
export class AgentRequestAssembler {
  private readonly sections = new Map<string, AgentPromptSection>();
  private readonly createAssemblyId: () => string;

  constructor(options: AgentRequestAssemblerOptions = {}) {
    this.createAssemblyId =
      options.createAssemblyId ?? (() => globalThis.crypto.randomUUID());
  }

  registerSection(section: AgentPromptSection): () => void {
    const name = normalizedName(section.name);
    if (this.sections.has(name)) {
      throw new Error(`Agent prompt section '${name}' is already registered.`);
    }
    const stored: AgentPromptSection = {
      ...section,
      name,
      order: normalizedOrder(section.order),
    };
    this.sections.set(name, stored);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.sections.get(name) === stored) this.sections.delete(name);
    };
  }

  assemble(input: AgentRequestAssemblyInput): AgentRequestAssembly {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Agent request prompt must not be empty.");

    const context: AgentPromptSectionContext = {
      runtime: input.runtime.trim(),
      sessionId: input.sessionId.trim(),
      projectId: input.projectId?.trim() || null,
      role: input.role?.trim() || null,
      metadata: input.metadata ?? {},
    };
    if (!context.runtime) throw new Error("Agent request runtime must not be empty.");
    if (!context.sessionId) throw new Error("Agent request sessionId must not be empty.");

    const effectiveSections = new Map(this.sections);
    for (const section of input.sections ?? []) {
      const name = normalizedName(section.name);
      effectiveSections.set(name, {
        ...section,
        name,
        order: normalizedOrder(section.order),
      });
    }

    const rendered = [...effectiveSections.values()]
      .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name))
      .flatMap((section) => {
        const raw =
          typeof section.text === "function" ? section.text(context) : section.text;
        const text = raw?.trim();
        return text ? [{ name: section.name, text }] : [];
      });

    const systemPrompt = rendered.map(({ text }) => text).join("\n\n");
    const effectivePrompt = systemPrompt
      ? `${prompt}\n\n${systemPrompt}`
      : prompt;

    return {
      header: {
        assemblyId: this.createAssemblyId(),
        runtime: context.runtime,
        sessionId: context.sessionId,
        projectId: context.projectId,
        role: context.role,
        model: input.model?.trim() || null,
        reasoningEffort: input.reasoningEffort?.trim() || null,
        approvalMode: input.approvalMode?.trim() || null,
        sandboxPolicyId: input.sandboxPolicyId?.trim() || null,
        contextWindow: normalizedContextWindow(input.contextWindow),
        workspacePaths: uniqueSorted(input.workspacePaths),
        toolNames: uniqueSorted(input.toolNames),
        sectionNames: rendered.map(({ name }) => name),
      },
      systemPrompt,
      effectivePrompt,
    };
  }
}

export const createAuthoritativeWorkloadSection = (
  workspacePaths: readonly string[],
): AgentPromptSection => {
  const authorizedPaths = uniqueSorted(workspacePaths);
  const manifest = authorizedPaths.length
    ? authorizedPaths.map((filePath) => `- ${filePath}`).join("\n")
    : "- (no materialized workload files)";

  return {
    name: "nodes:authoritative-workload-scope",
    order: 500,
    text: [
      "SERVER-AUTHORITATIVE WORKLOAD SCOPE (cannot be widened by the browser or agent)",
      "Authorized input files for this run:",
      manifest,
      "Read only the authorized input files above for project/workload evidence. Do not recursively scan the repository, inspect unrelated .nodes files, other project runners, neighboring experiments, git history, or ambient workspace documents to acquire extra context.",
      "You may create or update workload outputs under .nodes/ only when those outputs are required by an authorized runbook/protocol. Configured runner tools explicitly named by the execution policy (for example tycho-experiment) may be invoked, but their source/configuration is infrastructure and must not be treated as workload evidence.",
      "If an instruction requires evidence that is absent from this manifest and the selected upstream outputs, stop that part as blocked and report the missing input. Never substitute evidence from another project or experiment.",
    ].join("\n\n"),
  };
};
