export const AGENT_POLICY_SCOPES = ["global", "project", "agent", "execution"] as const;

export type AgentPolicyScope = (typeof AGENT_POLICY_SCOPES)[number];

export type AgentScopedPolicy = {
  scope: AgentPolicyScope;
  approvalModes?: readonly string[];
  sandboxPolicyIds?: readonly string[];
  toolNames?: readonly string[];
  workspacePaths?: readonly string[];
};

export type EffectiveAgentPolicy = {
  approvalModes: string[] | null;
  sandboxPolicyIds: string[] | null;
  toolNames: string[] | null;
  workspacePaths: string[] | null;
  appliedScopes: AgentPolicyScope[];
};

const SCOPE_RANK = new Map<AgentPolicyScope, number>(
  AGENT_POLICY_SCOPES.map((scope, index) => [scope, index]),
);

const normalizeSet = (values: readonly string[] | undefined) => {
  if (values === undefined) return null;
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
};

const intersect = (parent: string[] | null, child: string[] | null) => {
  if (child === null) return parent;
  if (parent === null) return child;
  const allowed = new Set(parent);
  return child.filter((value) => allowed.has(value));
};

/**
 * Resolves policy from broad to narrow scopes. A narrower scope may reduce an
 * allow-list but can never re-add a value removed by a broader scope. `undefined`
 * means "inherit"; an explicit empty list means "deny all" for that dimension.
 *
 * Enforcement still belongs to the trusted runtime/sandbox. This resolver only
 * produces the declarative, auditable policy that is safe to hand to it.
 */
export function resolveScopedAgentPolicy(
  policies: readonly AgentScopedPolicy[],
): EffectiveAgentPolicy {
  const seen = new Set<AgentPolicyScope>();
  const ordered = [...policies].sort(
    (left, right) => (SCOPE_RANK.get(left.scope) ?? 0) - (SCOPE_RANK.get(right.scope) ?? 0),
  );

  let approvalModes: string[] | null = null;
  let sandboxPolicyIds: string[] | null = null;
  let toolNames: string[] | null = null;
  let workspacePaths: string[] | null = null;
  const appliedScopes: AgentPolicyScope[] = [];

  for (const policy of ordered) {
    if (seen.has(policy.scope)) {
      throw new Error(`Agent policy scope '${policy.scope}' was provided more than once.`);
    }
    seen.add(policy.scope);
    appliedScopes.push(policy.scope);
    approvalModes = intersect(approvalModes, normalizeSet(policy.approvalModes));
    sandboxPolicyIds = intersect(sandboxPolicyIds, normalizeSet(policy.sandboxPolicyIds));
    toolNames = intersect(toolNames, normalizeSet(policy.toolNames));
    workspacePaths = intersect(workspacePaths, normalizeSet(policy.workspacePaths));
  }

  return {
    approvalModes,
    sandboxPolicyIds,
    toolNames,
    workspacePaths,
    appliedScopes,
  };
}

export function assertAgentPolicyAllows(
  effective: EffectiveAgentPolicy,
  request: {
    approvalMode?: string | null;
    sandboxPolicyId?: string | null;
    toolNames?: readonly string[];
    workspacePaths?: readonly string[];
  },
) {
  const checks: Array<[string, string | null | undefined, string[] | null]> = [
    ["approval mode", request.approvalMode, effective.approvalModes],
    ["sandbox policy", request.sandboxPolicyId, effective.sandboxPolicyIds],
  ];
  for (const [label, value, allowed] of checks) {
    if (value && allowed !== null && !allowed.includes(value)) {
      throw new Error(`Agent ${label} '${value}' is denied by scoped policy.`);
    }
  }

  const listChecks: Array<[string, readonly string[] | undefined, string[] | null]> = [
    ["tool", request.toolNames, effective.toolNames],
    ["workspace path", request.workspacePaths, effective.workspacePaths],
  ];
  for (const [label, values, allowed] of listChecks) {
    if (allowed === null) continue;
    const allowedSet = new Set(allowed);
    const denied = (values ?? []).map((value) => value.trim()).filter(Boolean).filter((value) => !allowedSet.has(value));
    if (denied.length > 0) {
      throw new Error(`Agent ${label} request is denied by scoped policy: ${denied.join(", ")}.`);
    }
  }
}
