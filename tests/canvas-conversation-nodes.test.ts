import { describe, expect, it } from "vitest";
import {
  parseManualConversationRoot,
  resolveCanvasConversationNodes,
} from "@/components/assistant-ui/thread-graph-flow/canvas-conversation-nodes";

describe("canvas conversation nodes", () => {
  it("keeps a new session canvas empty until a root is explicitly added", () => {
    expect(
      resolveCanvasConversationNodes({
        contextScopes: {},
        manualRoot: null,
        nodes: [],
      }),
    ).toEqual([]);
  });

  it("creates a manually positioned Conversation Root when requested", () => {
    const nodes = resolveCanvasConversationNodes({
      contextScopes: {},
      manualRoot: { position: { x: 120, y: 240 } },
      nodes: [],
    });

    expect(nodes).toEqual([
      expect.objectContaining({
        id: "__ROOT__",
        role: "ROOT",
        text: "Conversation Root",
        x: 120,
        y: 240,
      }),
    ]);
  });

  it("rejects invalid persisted root positions", () => {
    expect(parseManualConversationRoot('{"position":{"x":"bad","y":1}}')).toBeNull();
    expect(parseManualConversationRoot('{"position":null}')).toEqual({ position: null });
  });
});
