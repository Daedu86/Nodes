"use client";

import React from "react";
import {
  dedupeResourceIds,
  fetchApi,
  fetchJson,
  readStoredResourceId,
  writeStoredResourceId,
} from "@/lib/client/persisted-resource-client";
import {
  usePersistedResourceState,
  useSerialTaskQueue,
} from "@/components/context/use-persisted-resource-state";
import { useSession } from "next-auth/react";
import type {
  ProjectCollaboratorRole,
  ProjectDocument,
  ProjectSummary,
} from "@/lib/project-documents";
import type { ProjectMap } from "@/lib/project-map";
import { hasPostAuthChatHandoff } from "@/lib/client/post-auth-handoff";

type ProjectCreatePatch = {
  globalContext?: string;
  map?: ProjectMap;
  memoryIds?: string[];
  sessionIds?: string[];
  title?: string | null;
};

type ProjectUpdatePatch = ProjectCreatePatch & {
  arenaWinnerBranchKey?: string | null;
  arenaWinnerSessionId?: string | null;
};

type ProjectsContextValue = {
  activeProject: ProjectDocument | null;
  activeProjectId: string | null;
  clearActiveProject: () => void;
  createProject: (input?: ProjectCreatePatch) => Promise<ProjectDocument>;
  deleteProject: (projectId: string) => Promise<void>;
  deleteProjects: (projectIds: string[]) => Promise<void>;
  isReady: boolean;
  projects: ProjectSummary[];
  refreshProjects: () => Promise<ProjectSummary[]>;
  removeActiveProjectMember: (email: string) => Promise<ProjectDocument | null>;
  renameProject: (projectId: string, title: string | null) => Promise<void>;
  saveActiveProjectPatch: (patch: ProjectUpdatePatch) => Promise<ProjectDocument | null>;
  saveActiveProjectMember: (input: {
    email: string;
    role: ProjectCollaboratorRole;
  }) => Promise<ProjectDocument | null>;
  selectProject: (projectId: string) => Promise<void>;
};

type ProjectsListResponse = {
  projects: ProjectSummary[];
};

type ProjectResponse = {
  inviteUrl?: string;
  project: ProjectDocument;
};

const AUTO_OPEN_PROJECT_SESSION_THRESHOLD = 10;

const ProjectsContext = React.createContext<ProjectsContextValue | null>(null);

const readStoredActiveProjectId = (userId: string | null) =>
  readStoredResourceId("project", userId);

const writeStoredActiveProjectId = (
  userId: string | null,
  projectId: string | null,
) => writeStoredResourceId("project", userId, projectId);

async function exposeInvitationLink(inviteUrl: string) {
  try {
    await navigator.clipboard.writeText(inviteUrl);
  } catch {
    window.prompt("Copy this project invitation link", inviteUrl);
  }
}

export function ProjectsProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();
  const userId = session?.user?.id ?? null;
  const {
    activeResource: activeProject,
    activeResourceRef: activeProjectRef,
    prependResource: prependProject,
    resources: projects,
    setActiveResource: setActiveProject,
    setResources: setProjects,
    updateKnownResource: updateKnownProject,
  } = usePersistedResourceState<ProjectSummary, ProjectDocument>();
  const enqueueProjectPatch = useSerialTaskQueue<ProjectDocument | null>(null);
  const [isReady, setIsReady] = React.useState(false);

  const loadProject = React.useCallback(async (projectId: string) => {
    const data = await fetchJson<ProjectResponse>(`/api/projects/${projectId}`);
    setActiveProject(data.project);
    writeStoredActiveProjectId(userId, data.project.id);
    return data.project;
  }, [setActiveProject, userId]);

  const refreshProjects = React.useCallback(async () => {
    const data = await fetchJson<ProjectsListResponse>("/api/projects");
    setProjects(data.projects);
    return data.projects;
  }, [setProjects]);

  React.useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      if (status === "loading") {
        return;
      }
      setIsReady(false);
      try {
        if (!userId) {
          if (mounted) {
            setProjects([]);
            setActiveProject(null);
            setIsReady(true);
          }
          return;
        }
        const loadedProjects = await refreshProjects();
        const shouldStayInWorkspace = hasPostAuthChatHandoff();
        const preferredId = readStoredActiveProjectId(userId);
        const preferredProject = preferredId
          ? loadedProjects.find((project) => project.id === preferredId) ?? null
          : null;

        if (shouldStayInWorkspace) {
          if (mounted) {
            setActiveProject(null);
            writeStoredActiveProjectId(userId, null);
          }
        } else if (
          preferredProject &&
          preferredProject.sessionCount >= AUTO_OPEN_PROJECT_SESSION_THRESHOLD
        ) {
          if (mounted) {
            setActiveProject(null);
            writeStoredActiveProjectId(userId, null);
          }
        } else if (preferredId && loadedProjects.some((project) => project.id === preferredId)) {
          try {
            await loadProject(preferredId);
          } catch {
            if (mounted) {
              setActiveProject(null);
              writeStoredActiveProjectId(userId, null);
            }
          }
        } else if (mounted) {
          setActiveProject(null);
          writeStoredActiveProjectId(userId, null);
        }
      } finally {
        if (mounted) {
          setIsReady(true);
        }
      }
    };

    void bootstrap();

    return () => {
      mounted = false;
    };
  }, [
    loadProject,
    refreshProjects,
    setActiveProject,
    setProjects,
    status,
    userId,
  ]);

  const clearActiveProject = React.useCallback(() => {
    setActiveProject(null);
    writeStoredActiveProjectId(userId, null);
  }, [setActiveProject, userId]);

  const selectProject = React.useCallback(async (projectId: string) => {
    const isSwitchingProject = activeProjectRef.current?.id !== projectId;
    if (isSwitchingProject) {
      setIsReady(false);
    }
    try {
      await loadProject(projectId);
    } finally {
      if (isSwitchingProject) {
        setIsReady(true);
      }
    }
  }, [activeProjectRef, loadProject]);

  const createProject = React.useCallback(async (input?: ProjectCreatePatch) => {
    setIsReady(false);
    try {
      const data = await fetchJson<ProjectResponse>("/api/projects", {
        method: "POST",
        body: JSON.stringify(input ?? {}),
      });
      prependProject(data.project);
      setActiveProject(data.project);
      writeStoredActiveProjectId(userId, data.project.id);
      return data.project;
    } finally {
      setIsReady(true);
    }
  }, [prependProject, setActiveProject, userId]);

  const deleteProjects = React.useCallback(async (projectIds: string[]) => {
    const uniqueProjectIds = dedupeResourceIds(projectIds);
    if (uniqueProjectIds.length === 0) return;
    const currentActiveProjectId = activeProjectRef.current?.id ?? null;
    const deletingActiveProject =
      currentActiveProjectId !== null && uniqueProjectIds.includes(currentActiveProjectId);

    if (deletingActiveProject) {
      setActiveProject(null);
      writeStoredActiveProjectId(userId, null);
    }

    await fetchApi(
      "/api/projects",
      {
        method: "DELETE",
        body: JSON.stringify({ projectIds: uniqueProjectIds }),
      },
      { allowedStatuses: [404] },
    );

    const remaining = await refreshProjects();
    if (deletingActiveProject) {
      const nextProjectId = remaining[0]?.id ?? null;
      if (nextProjectId) {
        await loadProject(nextProjectId);
      } else {
        clearActiveProject();
      }
    }
  }, [
    activeProjectRef,
    clearActiveProject,
    loadProject,
    refreshProjects,
    setActiveProject,
    userId,
  ]);

  const deleteProject = React.useCallback(async (projectId: string) => {
    await deleteProjects([projectId]);
  }, [deleteProjects]);

  const renameProject = React.useCallback(async (projectId: string, title: string | null) => {
    const data = await fetchJson<ProjectResponse>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
    updateKnownProject(data.project);
  }, [updateKnownProject]);

  const saveActiveProjectPatch = React.useCallback((patch: ProjectUpdatePatch) => {
    const enqueue = async () => {
      const projectId = activeProjectRef.current?.id;
      if (!projectId) return null;
      const data = await fetchJson<ProjectResponse>(`/api/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      updateKnownProject(data.project);
      return data.project;
    };

    return enqueueProjectPatch(enqueue);
  }, [activeProjectRef, enqueueProjectPatch, updateKnownProject]);

  const saveActiveProjectMember = React.useCallback(async (input: {
    email: string;
    role: ProjectCollaboratorRole;
  }) => {
    const projectId = activeProjectRef.current?.id;
    if (!projectId) return null;
    const data = await fetchJson<ProjectResponse>(`/api/projects/${projectId}/members`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (data.inviteUrl) {
      await exposeInvitationLink(data.inviteUrl);
    }
    updateKnownProject(data.project);
    return data.project;
  }, [activeProjectRef, updateKnownProject]);

  const removeActiveProjectMember = React.useCallback(async (email: string) => {
    const projectId = activeProjectRef.current?.id;
    if (!projectId) return null;
    const data = await fetchJson<ProjectResponse>(`/api/projects/${projectId}/members`, {
      method: "DELETE",
      body: JSON.stringify({ email }),
    });
    updateKnownProject(data.project);
    return data.project;
  }, [activeProjectRef, updateKnownProject]);

  const value = React.useMemo<ProjectsContextValue>(() => ({
    activeProject,
    activeProjectId: activeProject?.id ?? null,
    clearActiveProject,
    createProject,
    deleteProject,
    deleteProjects,
    isReady,
    projects,
    refreshProjects,
    removeActiveProjectMember,
    renameProject,
    saveActiveProjectMember,
    saveActiveProjectPatch,
    selectProject,
  }), [
    activeProject,
    clearActiveProject,
    createProject,
    deleteProject,
    deleteProjects,
    isReady,
    projects,
    refreshProjects,
    removeActiveProjectMember,
    renameProject,
    saveActiveProjectMember,
    saveActiveProjectPatch,
    selectProject,
  ]);

  return <ProjectsContext.Provider value={value}>{children}</ProjectsContext.Provider>;
}

export function useProjects() {
  const context = React.useContext(ProjectsContext);
  if (!context) {
    throw new Error("useProjects must be used within ProjectsProvider");
  }
  return context;
}
