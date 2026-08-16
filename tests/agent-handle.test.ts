import { describe, expect, it } from "vitest";
import {
  AgentHandleCapabilityError,
  getAgentHandle,
} from "@/lib/agents/runtime/handle";

describe("AgentHandle", () => {
  it("exposes one provider-neutral lifecycle surface", () => {
    const codex = getAgentHandle("codex", { ownerId: "owner-1", runId: "run-1" });
    const nooa = getAgentHandle("nooa", { ownerId: "owner-1", runId: "run-2" });

    expect(codex.capabilities).toEqual([
      "cancel",
      "event_stream",
      "approvals",
      "status",
      "wait_until_idle",
      "resume",
      "fork",
    ]);
    expect(nooa.capabilities).toEqual([
      "cancel",
      "event_stream",
      "status",
      "wait_until_idle",
      "resume",
      "fork",
    ]);
    expect(codex.runtime).toBe("codex");
    expect(nooa.runtime).toBe("nooa");
    expect(codex.resume()).toEqual({
      kind: "resume",
      sourceRuntime: "codex",
      sourceRunId: "run-1",
    });
    expect(nooa.fork()).toEqual({
      kind: "fork",
      sourceRuntime: "nooa",
      sourceRunId: "run-2",
    });
  });

  it("fails loudly when a runtime lacks a requested lifecycle capability", async () => {
    const handle = getAgentHandle("nooa", { ownerId: "owner-1", runId: "run-2" });

    await expect(
      handle.resolveApproval("approval-1", "accept"),
    ).rejects.toBeInstanceOf(AgentHandleCapabilityError);
    await expect(
      handle.resolveApproval("approval-1", "accept"),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      runtime: "nooa",
      capability: "approvals",
    });
  });
});
