import type { AgentRuntimeCatalog } from "@/lib/agents/runtime/types";

export const AGENT_RUNTIME_CATALOG: AgentRuntimeCatalog = {
  codex: {
    id: "codex",
    label: "Codex",
    deliveryStatus: "enabled",
    capabilities: ["approvals", "child_agents", "event_stream", "file_changes"],
    supportedRoles: ["coder", "reviewer", "researcher", "tester", "custom"],
    requiresOpenShellPolicy: false,
  },
  nooa: {
    id: "nooa",
    label: "NOOA",
    deliveryStatus: "enabled",
    capabilities: ["event_stream", "sandbox_policy", "trace_export"],
    supportedRoles: ["custom"],
    requiresOpenShellPolicy: true,
  },
};
