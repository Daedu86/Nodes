import { describe, expect, it } from "vitest";
import {
  CodexGeneratorApprovalRequiredError,
  consumeCodexGeneratorStream,
} from "../lib/tycho/codex-evolution-run-output";

const runId = "generator-run";

const sseResponse = (...notifications: Array<{ method: string; params?: unknown }>) =>
  new Response(
    notifications
      .map((notification, index) =>
        `id: ${index + 1}\ndata: ${JSON.stringify({
          id: String(index + 1),
          runId,
          notification,
        })}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const consume = (response: Response, maxOutputChars = 10_000) =>
  consumeCodexGeneratorStream({
    response,
    runId,
    timeoutMs: 1_000,
    maxOutputChars,
  });

describe("Codex evolution generator stream", () => {
  it("uses the completed agent message and requires terminal run completion", async () => {
    const output = '{"variants":[{"id":"a"}]}';
    await expect(
      consume(
        sseResponse(
          {
            method: "item/completed",
            params: {
              item: {
                type: "agentMessage",
                content: [{ text: output }],
              },
            },
          },
          { method: "turn/completed", params: {} },
        ),
      ),
    ).resolves.toBe(output);
  });

  it("fails closed when Codex asks for approval", async () => {
    await expect(
      consume(
        sseResponse({
          method: "tool/approval/requested",
          params: { approvalId: "approval-1" },
        }),
      ),
    ).rejects.toBeInstanceOf(CodexGeneratorApprovalRequiredError);
  });

  it("propagates failed runs instead of parsing partial output", async () => {
    await expect(
      consume(sseResponse({ method: "turn/failed", params: { message: "boom" } })),
    ).rejects.toThrow("run failed");
  });

  it("rejects streams that end without a terminal completion event", async () => {
    await expect(
      consume(
        sseResponse({
          method: "item/completed",
          params: { item: { type: "agentMessage", content: [{ text: "{}" }] } },
        }),
      ),
    ).rejects.toThrow("ended before run completion");
  });

  it("enforces a bounded final response", async () => {
    await expect(
      consume(
        sseResponse(
          {
            method: "item/completed",
            params: { item: { type: "agentMessage", content: [{ text: "0123456789" }] } },
          },
          { method: "turn/completed", params: {} },
        ),
        5,
      ),
    ).rejects.toThrow("exceeds 5 characters");
  });
});
