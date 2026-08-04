// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_BLOCK_DRAG_MIME,
  CanvasBlockLibrary,
  INITIAL_CANVAS_BLOCKS,
} from "@/components/assistant-ui/thread-graph-flow/block-library";

afterEach(() => cleanup());

const renderLibrary = (onAddBlock = vi.fn()) => {
  const onAddAgent = vi.fn();
  render(
    <CanvasBlockLibrary
      collapsed
      onAddAgent={onAddAgent}
      onAddBlock={onAddBlock}
      onCollapsedChange={() => undefined}
    />,
  );
  return { onAddAgent, onAddBlock };
};

describe("CanvasBlockLibrary", () => {
  it("renders a permanently compact rail without obsolete expand, collapse, or search controls", () => {
    renderLibrary();

    const library = screen.getByRole("complementary", { name: "Block library" });
    expect(library.className).toContain("w-14");
    expect(screen.getAllByRole("button")).toHaveLength(INITIAL_CANVAS_BLOCKS.length + 1);
    expect(screen.queryByRole("button", { name: /Expand block library/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Collapse block library/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /Search blocks/i })).toBeNull();
  });

  it("adds a Codex agent from the rail and provides brief hover help", () => {
    const { onAddAgent } = renderLibrary();
    const addAgent = screen.getByRole("button", {
      name: "Add Codex agent to canvas",
    });

    expect(addAgent.getAttribute("title")).toBe(
      "Add a Codex agent to run an independent task on the canvas.",
    );
    fireEvent.click(addAgent);
    expect(onAddAgent).toHaveBeenCalledOnce();
  });

  it("keeps each block description in the existing hover help and accessible name", () => {
    renderLibrary();

    const prompt = screen.getByRole("button", {
      name: "Add Prompt block. Run a model instruction with connected inputs and outputs.",
    });
    const plan = screen.getByRole("button", {
      name: "Add Plan block. Ordered steps, dependencies, and verification.",
    });

    expect(prompt.getAttribute("title")).toBe(
      "Process: Prompt — Run a model instruction with connected inputs and outputs. Click to add or drag onto the canvas.",
    );
    expect(plan.getAttribute("title")).toBe(
      "Output: Plan — Ordered steps, dependencies, and verification. Click to add or drag onto the canvas.",
    );
  });

  it("supports click-to-add", async () => {
    const user = userEvent.setup();
    const { onAddBlock } = renderLibrary();

    await user.click(
      screen.getByRole("button", {
        name: "Add Plan block. Ordered steps, dependencies, and verification.",
      }),
    );

    expect(onAddBlock).toHaveBeenCalledWith(expect.objectContaining({ id: "output-plan" }));
  });

  it("offers Conversation Root as an optional process node", async () => {
    const user = userEvent.setup();
    const { onAddBlock } = renderLibrary();
    const root = screen.getByRole("button", {
      name: "Add Conversation Root block. Optional starting point for a conversation tree.",
    });

    expect(root.getAttribute("title")).toContain(
      "Optional starting point for a conversation tree.",
    );
    await user.click(root);
    expect(onAddBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "root",
        id: "process-conversation-root",
      }),
    );
  });

  it("publishes both canvas-specific and plain-text drag data", () => {
    renderLibrary();
    const textButton = screen.getByRole("button", {
      name: "Add Text block. Reusable narrative context.",
    });
    const setData = vi.fn();
    const dataTransfer = { effectAllowed: "none", setData };

    fireEvent.dragStart(textButton, { dataTransfer });

    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(setData).toHaveBeenCalledWith(CANVAS_BLOCK_DRAG_MIME, "input-text");
    expect(setData).toHaveBeenCalledWith("text/plain", "input-text");
  });
});
