import { describe, expect, it } from "vitest";
import { compileAgentNode } from "@/lib/agents/runtime/compiler";

describe("compileAgentNode", () => {
  it("normalizes a valid Codex Canvas node into a deterministic run plan", () => {
    const result = compileAgentNode({
      id: " node-1 ",
      runtime: "codex",
      sessionId: " session-1 ",
      projectId: " project-1 ",
      workspaceId: " workspace-1 ",
      parentRunId: " parent-run ",
      prompt: "  Review the integration plan.  ",
      label: "  Architecture reviewer ",
      role: "reviewer",
      metadata: { source: "canvas" },
    });

    expect(result).toEqual({
      ok: true,
      run: {
        schemaVersion: 1,
        nodeId: "node-1",
        runtime: "codex",
        sessionId: "session-1",
        projectId: "project-1",
        workspaceId: "workspace-1",
        parentRunId: "parent-run",
        prompt: "Review the integration plan.",
        label: "Architecture reviewer",
        role: "reviewer",
        sandbox: null,
        metadata: { source: "canvas" },
      },
    });
  });

  it("requires an OpenShell policy for a NOOA node", () => {
    const result = compileAgentNode({
      id: "node-1",
      runtime: "nooa",
      sessionId: "session-1",
      prompt: "Summarize the project state.",
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: "missing_openshell_policy",
          path: "sandbox",
          message: "NOOA execution requires an OpenShell policy binding.",
        },
      ],
    });
  });

  it("accepts a NOOA node only with a server-resolved OpenShell policy reference", () => {
    const result = compileAgentNode({
      id: "node-1",
      runtime: "nooa",
      sessionId: "session-1",
      prompt: "Summarize the project state.",
      sandbox: {
        provider: "openshell",
        policyId: "nodes-default-no-network",
        profileId: "python-agent",
      },
    });

    expect(result).toEqual({
      ok: true,
      run: expect.objectContaining({
        runtime: "nooa",
        role: "custom",
        sandbox: {
          provider: "openshell",
          policyId: "nodes-default-no-network",
          profileId: "python-agent",
        },
      }),
    });
  });

  it("reports invalid node fields together so the Canvas can render actionable feedback", () => {
    const result = compileAgentNode({
      id: " ",
      runtime: "codex",
      sessionId: "",
      prompt: " ",
      role: "operator",
    });

    expect(result).toEqual({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "missing_node_id", path: "id" }),
        expect.objectContaining({ code: "missing_session_id", path: "sessionId" }),
        expect.objectContaining({ code: "missing_prompt", path: "prompt" }),
        expect.objectContaining({ code: "unsupported_role", path: "role" }),
      ]),
    });
  });
});
