// @vitest-environment jsdom

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SessionUiStateProvider, useSessionUiState } from "@/components/context/session-ui-state";
import { AppHeader } from "@/components/workspace/app-header";
import { buildWorkspaceOnboardingStorageKey } from "@/lib/client/workspace-onboarding";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "header-user" } },
    status: "authenticated",
  }),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => <button type="button">Sidebar</button>,
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <div data-testid="separator" />,
}));

vi.mock("@/components/ui/breadcrumb", () => ({
  Breadcrumb: ({ children }: { children: React.ReactNode }) => <nav>{children}</nav>,
  BreadcrumbItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BreadcrumbList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BreadcrumbPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/assistant-ui/thread-title", () => ({
  ThreadTitleEditor: () => <span>Thread</span>,
}));

vi.mock("@/components/assistant-ui/model-selector", () => ({
  ModelSelector: () => <div>Model selector</div>,
}));

vi.mock("@/components/assistant-ui/llm-toggle", () => ({
  LlmToggleButton: () => <button type="button">AI toggle</button>,
}));

vi.mock("@/components/workspace/session-context-sheet", () => ({
  SessionContextSheet: () => <button type="button">Context</button>,
}));

vi.mock("@/components/workspace/evolution-session-sheet", () => ({
  EvolutionSessionSheet: () => <button type="button">Evolution</button>,
}));

function HeaderHarness() {
  const { setViewMode, viewMode } = useSessionUiState();

  return (
    <div>
      <div data-testid="view-mode">{viewMode}</div>
      <button type="button" onClick={() => setViewMode("chat")}>
        Set chat
      </button>
      <AppHeader />
    </div>
  );
}

describe("AppHeader", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(buildWorkspaceOnboardingStorageKey("header-user"), "1");
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("uses the main Split control as a reversible toggle", () => {
    render(
      <SessionUiStateProvider sessionId="header-session">
        <HeaderHarness />
      </SessionUiStateProvider>,
    );

    expect(screen.getByTestId("view-mode").textContent).toBe("split");

    fireEvent.click(screen.getByRole("button", { name: "Exit split workspace" }));
    expect(screen.getByTestId("view-mode").textContent).toBe("canvas");

    fireEvent.click(screen.getByRole("button", { name: "Set chat" }));
    expect(screen.getByTestId("view-mode").textContent).toBe("chat");

    fireEvent.click(screen.getByRole("button", { name: "Open split workspace" }));
    expect(screen.getByTestId("view-mode").textContent).toBe("split");

    fireEvent.click(screen.getByRole("button", { name: "Exit split workspace" }));
    expect(screen.getByTestId("view-mode").textContent).toBe("chat");
  });
});
