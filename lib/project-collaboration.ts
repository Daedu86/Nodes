import type { ProjectDocument, ProjectSummary } from "@/lib/project-documents";
import {
  createProject,
  getProjectRecordForActor,
  listProjectsForActor,
  patchProject,
  removeProjectMember,
  upsertProjectMember,
  type ProjectActor,
  type ProjectCreateInput,
  type ProjectMemberInput,
  type ProjectPatch,
} from "@/lib/project-store";
import type { AuthenticatedUser } from "@/lib/server/auth-user";
import { listMemoryItems } from "@/lib/memory-store";
import { getSession } from "@/lib/session-store";

export class ProjectAccessError extends Error {
  status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
  }
}

export const toProjectActor = (user: AuthenticatedUser): ProjectActor => ({
  userEmail: user.email,
  userId: user.id,
});

export const canEditProject = (project: Pick<ProjectDocument, "accessRole">) =>
  project.accessRole === "owner" || project.accessRole === "editor";

export const canManageProjectStructure = (project: Pick<ProjectDocument, "accessRole">) =>
  project.accessRole === "owner";

const hydrateProjectDocument = async (
  project: Awaited<ReturnType<typeof getProjectRecordForActor>>,
): Promise<ProjectDocument> => {
  const [sessions, memoryItems] = await Promise.all([
    Promise.all(
      project.sessionIds.map(async (sessionId) => {
        try {
          return await getSession(sessionId, project.ownerId);
        } catch {
          return null;
        }
      }),
    ),
    listMemoryItems({ ownerId: project.ownerId }),
  ]);
  const sessionIds = new Set(project.sessionIds);
  const memoryIds = new Set(project.memoryIds);
  return {
    accessRole: project.accessRole,
    arenaWinnerBranchKey: project.arenaWinnerBranchKey,
    arenaWinnerSessionId: project.arenaWinnerSessionId,
    attachedMemoryItems: memoryItems.filter((item) => memoryIds.has(item.id)),
    createdAt: project.createdAt,
    globalContext: project.globalContext,
    id: project.id,
    map: project.map,
    members: project.members,
    memoryIds: project.memoryIds,
    sessionCount: project.sessionCount,
    sessionIds: project.sessionIds,
    sessions: sessions
      .filter((session): session is Exclude<(typeof sessions)[number], null> => session !== null)
      .filter((session) => sessionIds.has(session.id)),
    title: project.title,
    updatedAt: project.updatedAt,
  };
};

const assertEditable = (project: ProjectDocument) => {
  if (!canEditProject(project)) {
    throw new ProjectAccessError("You do not have permission to edit this project.", 403);
  }
};

const assertOwner = (project: ProjectDocument) => {
  if (!canManageProjectStructure(project)) {
    throw new ProjectAccessError("Only the project owner can manage this part of the project.", 403);
  }
};

const patchTouchesOwnerOnlyFields = (patch: ProjectPatch) =>
  patch.map !== undefined || patch.sessionIds !== undefined || patch.memoryIds !== undefined;

export async function listProjectsForUser(user: AuthenticatedUser): Promise<ProjectSummary[]> {
  return listProjectsForActor(toProjectActor(user));
}

export async function getProjectForUser(projectId: string, user: AuthenticatedUser): Promise<ProjectDocument> {
  return hydrateProjectDocument(await getProjectRecordForActor(projectId, toProjectActor(user)));
}

export async function createProjectForUser(
  input: ProjectCreateInput,
  user: AuthenticatedUser,
): Promise<ProjectDocument> {
  const created = await createProject({ ...input, ownerId: user.id });
  return getProjectForUser(created.id, user);
}

export async function patchProjectForUser(
  projectId: string,
  patch: ProjectPatch,
  user: AuthenticatedUser,
): Promise<ProjectDocument> {
  const project = await getProjectForUser(projectId, user);
  assertEditable(project);
  if (project.accessRole !== "owner" && patchTouchesOwnerOnlyFields(patch)) {
    throw new ProjectAccessError("Only the project owner can change the project map, attached sessions, or typed nodes.", 403);
  }
  const updated = await patchProject(
    projectId,
    patch,
    project.accessRole === "owner"
      ? user.id
      : (await getProjectRecordForActor(projectId, toProjectActor(user))).ownerId,
  );
  return getProjectForUser(updated.id, user);
}

export async function upsertProjectMemberForUser(
  projectId: string,
  member: ProjectMemberInput,
  user: AuthenticatedUser,
): Promise<ProjectDocument> {
  const project = await getProjectForUser(projectId, user);
  assertOwner(project);
  const email = member.email.trim().toLowerCase();
  const accepted = project.members.find(
    (entry) => entry.email === email && entry.status === "accepted",
  );
  if (!accepted) {
    throw new ProjectAccessError(
      "New collaborators must accept a project invitation before membership is active.",
      409,
    );
  }
  await upsertProjectMember(projectId, {
    acceptedAt: accepted.acceptedAt,
    email,
    invitationId: accepted.invitationId,
    role: member.role,
    userId: accepted.userId,
  }, user.id);
  return getProjectForUser(projectId, user);
}

export async function removeProjectMemberForUser(
  projectId: string,
  memberEmail: string,
  user: AuthenticatedUser,
): Promise<ProjectDocument> {
  const project = await getProjectForUser(projectId, user);
  assertOwner(project);
  await removeProjectMember(projectId, memberEmail, user.id);
  return getProjectForUser(projectId, user);
}
