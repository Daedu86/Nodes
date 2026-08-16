import { describe, expect, it } from "vitest";
import {
  AgentHandleCapabilityError,
  getAgentHandle,
} from "@/lib/agents/runtime/handle";

describe("AgentHandle", () => {
  it("exposes one provider-neutral lifecycle surface", () => {
    const codex = getAgentHandle("codex", { ownerId: "owner-1", runId: "run-1" });
    const nooa = getAgentHandle("nooa", { ownerId: "owner-1", runId: "run-2" });

    expect(codex.capabilities).toEqual(["cancel", "event_stream", "approvals"]);
    expect(nooa.capabilities).toEqual(["cancel", "event_stream"]);
    expect(codex.runtime).toBe("codex");
    expect(nooa.runtime).toBe("nooa");
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
