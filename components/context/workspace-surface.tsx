"use client";

import React from "react";
import { useSession } from "next-auth/react";
import { hasPostAuthChatHandoff } from "@/lib/client/post-auth-handoff";

export type WorkspaceSurface =
  | "admin-users"
  | "agent-access"
  | "agent-work"
  | "llm-models"
  | "plan-usage"
  | "support"
  | "workspace";

type WorkspaceSurfaceContextValue = {
  activeSurface: WorkspaceSurface;
  showAdminUsers: () => void;
  showAgentAccess: () => void;
  showAgentWork: () => void;
  showPlanUsage: () => void;
  showSupport: () => void;
  setActiveSurface: (value: WorkspaceSurface) => void;
  showLlmModels: () => void;
  showWorkspace: () => void;
};

const WorkspaceSurfaceContext = React.createContext<WorkspaceSurfaceContextValue | null>(null);

const DEFAULT_SURFACE: WorkspaceSurface = "workspace";

const readSurface = (storageKey: string) => {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === "admin-users") return "admin-users";
    if (value === "agent-access") return "agent-access";
    if (value === "agent-work") return "agent-work";
    if (value === "llm-models") return "llm-models";
    if (value === "plan-usage") return "plan-usage";
    if (value === "support") return "support";
    return DEFAULT_SURFACE;
  } catch {
    return DEFAULT_SURFACE;
  }
};

export function WorkspaceSurfaceProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { data: session } = useSession();
  const storageKey = React.useMemo(
    () => `nodes.workspace-surface.v1:${session?.user?.id ?? "guest"}`,
    [session?.user?.id],
  );
  const [activeSurface, setActiveSurface] = React.useState<WorkspaceSurface>(DEFAULT_SURFACE);
  const hasLoadedRef = React.useRef(false);

  React.useEffect(() => {
    const next = hasPostAuthChatHandoff() ? DEFAULT_SURFACE : readSurface(storageKey);
    hasLoadedRef.current = true;
    setActiveSurface(next);
  }, [storageKey]);

  React.useEffect(() => {
    if (!hasLoadedRef.current) return;
    try {
      localStorage.setItem(storageKey, activeSurface);
    } catch {
      // ignore storage errors
    }
  }, [activeSurface, storageKey]);

  React.useEffect(() => {
    const showAgentWork = () => setActiveSurface("agent-work");
    window.addEventListener("nodes:show-agent-work", showAgentWork);
    return () => window.removeEventListener("nodes:show-agent-work", showAgentWork);
  }, []);

  const value = React.useMemo<WorkspaceSurfaceContextValue>(
    () => ({
      activeSurface,
      showAdminUsers: () => setActiveSurface("admin-users"),
      showAgentAccess: () => setActiveSurface("agent-access"),
      showAgentWork: () => setActiveSurface("agent-work"),
      showPlanUsage: () => setActiveSurface("plan-usage"),
      showSupport: () => setActiveSurface("support"),
      setActiveSurface,
      showLlmModels: () => setActiveSurface("llm-models"),
      showWorkspace: () => setActiveSurface("workspace"),
    }),
    [activeSurface],
  );

  return (
    <WorkspaceSurfaceContext.Provider value={value}>
      {children}
    </WorkspaceSurfaceContext.Provider>
  );
}

export function useWorkspaceSurface() {
  const context = React.useContext(WorkspaceSurfaceContext);
  if (!context) {
    throw new Error("useWorkspaceSurface must be used within WorkspaceSurfaceProvider");
  }
  return context;
}
