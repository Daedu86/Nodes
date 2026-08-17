import { describe, expect, it } from "vitest";
import {
  assertAgentPolicyAllows,
  resolveScopedAgentPolicy,
} from "@/lib/agents/kernel/policy";

describe("scoped agent policy", () => {
  it("allows narrower scopes to restrict but never re-add permissions", () => {
    const policy = resolveScopedAgentPolicy([
      {
        scope: "global",
        toolNames: ["read", "write", "shell"],
        workspacePaths: ["/work", "/shared"],
      },
      {
        scope: "project",
        toolNames: ["read", "write"],
        workspacePaths: ["/work"],
      },
      {
        scope: "execution",
        toolNames: ["write", "shell"],
        workspacePaths: ["/shared", "/work"],
      },
    ]);

    expect(policy.toolNames).toEqual(["write"]);
    expect(policy.workspacePaths).toEqual(["/work"]);
    expect(policy.appliedScopes).toEqual(["global", "project", "execution"]);
    expect(() => assertAgentPolicyAllows(policy, { toolNames: ["shell"] })).toThrow(
      /denied by scoped policy/u,
    );
    expect(() => assertAgentPolicyAllows(policy, { toolNames: ["write"] })).not.toThrow();
  });

  it("treats an explicit empty list as deny-all and undefined as inherit", () => {
    const policy = resolveScopedAgentPolicy([
      { scope: "global", approvalModes: ["manual", "auto"] },
      { scope: "project" },
      { scope: "agent", approvalModes: [] },
      { scope: "execution", approvalModes: ["manual"] },
    ]);

    expect(policy.approvalModes).toEqual([]);
    expect(() => assertAgentPolicyAllows(policy, { approvalMode: "manual" })).toThrow(
      /approval mode/u,
    );
  });

  it("rejects duplicate scope definitions", () => {
    expect(() =>
      resolveScopedAgentPolicy([
        { scope: "project", toolNames: ["read"] },
        { scope: "project", toolNames: ["write"] },
      ]),
    ).toThrow(/provided more than once/u);
  });
});
