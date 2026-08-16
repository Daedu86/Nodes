import { AGENT_RUNTIME_CATALOG } from "@/lib/agents/runtime/catalog";
import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  type AgentRuntimeCatalog,
  type AgentRuntimeCompileIssue,
  type AgentRuntimeNode,
  type CompileAgentNodeResult,
} from "@/lib/agents/runtime/types";

const trimmed = (value: string | null | undefined) => value?.trim() ?? "";

const issue = (
  code: AgentRuntimeCompileIssue["code"],
  path: string,
  message: string,
): AgentRuntimeCompileIssue => ({ code, path, message });

/**
 * Validate and normalize a Canvas agent node into a provider-neutral run plan.
 *
 * Compilation is deterministic: it does not allocate a run ID, call a provider,
 * or inspect the local filesystem. Runtime gateways own those side effects.
 */
export function compileAgentNode(
  node: AgentRuntimeNode,
  catalog: AgentRuntimeCatalog = AGENT_RUNTIME_CATALOG,
): CompileAgentNodeResult {
  const definition = catalog[node.runtime];
  const nodeId = trimmed(node.id);
  const sessionId = trimmed(node.sessionId);
  const prompt = trimmed(node.prompt);
  const role = trimmed(node.role) || "custom";
  const issues: AgentRuntimeCompileIssue[] = [];

  if (!nodeId) {
    issues.push(issue("missing_node_id", "id", "An agent node needs a stable Canvas node id."));
  }
  if (!sessionId) {
    issues.push(issue("missing_session_id", "sessionId", "An agent node must belong to a session."));
  }
  if (!prompt) {
    issues.push(issue("missing_prompt", "prompt", "An agent node needs a prompt before it can run."));
  }
  if (!definition.supportedRoles.includes(role)) {
    issues.push(
      issue(
        "unsupported_role",
        "role",
        `${definition.label} does not support the '${role}' role.`,
      ),
    );
  }

  let continuation = node.continuation ?? null;
  if (continuation) {
    const kind = continuation.kind;
    const sourceRuntime = continuation.sourceRuntime;
    const sourceRunId = trimmed(continuation.sourceRunId);
    if (
      (kind !== "resume" && kind !== "fork") ||
      (sourceRuntime !== "codex" && sourceRuntime !== "nooa") ||
      !sourceRunId
    ) {
      issues.push(
        issue(
          "invalid_continuation",
          "continuation",
          "Agent continuation requires resume/fork, a supported source runtime, and a source run id.",
        ),
      );
      continuation = null;
    } else {
      continuation = { kind, sourceRuntime, sourceRunId };
    }
  }

  const sandbox = node.sandbox ?? null;
  if (definition.requiresOpenShellPolicy && !sandbox) {
    issues.push(
      issue(
        "missing_openshell_policy",
        "sandbox",
        `${definition.label} execution requires an OpenShell policy binding.`,
      ),
    );
  }
  if (sandbox && !trimmed(sandbox.policyId)) {
    issues.push(
      issue(
        "invalid_openshell_policy",
        "sandbox.policyId",
        "An OpenShell sandbox binding must reference a policy id.",
      ),
    );
  }

  if (issues.length) return { ok: false, issues };

  return {
    ok: true,
    run: {
      schemaVersion: AGENT_RUNTIME_SCHEMA_VERSION,
      nodeId,
      runtime: node.runtime,
      sessionId,
      prompt,
      label: trimmed(node.label) || `${definition.label} Agent`,
      role,
      projectId: trimmed(node.projectId) || null,
      workspaceId: trimmed(node.workspaceId) || null,
      parentRunId: trimmed(node.parentRunId) || null,
      ...(continuation ? { continuation } : {}),
      sandbox: sandbox
        ? {
          provider: "openshell",
          policyId: trimmed(sandbox.policyId),
          profileId: trimmed(sandbox.profileId) || null,
        }
        : null,
      metadata: node.metadata ?? {},
    },
  };
}
