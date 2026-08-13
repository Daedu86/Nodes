import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ProjectActor,
  ProjectCreateInput,
  ProjectMemberInput,
  ProjectPatch,
  ProjectRecord,
  ProjectRepository,
} from "@/lib/persistence/project-repository";
import {
  normalizeProjectDocument,
  type ProjectDocument,
  type ProjectMember,
  type ProjectSummary,
} from "@/lib/project-documents";
import { normalizeProjectMap } from "@/lib/project-map";

type StoredProject = Omit<ProjectDocument, "accessRole" | "sessionCount"> & {
  ownerId: string | null;
};

const PROJECT_FILE_EXTENSION = ".json";

export const getProjectStoreDir = () =>
  process.env.PROJECT_STORE_DIR
    ? path.resolve(process.env.PROJECT_STORE_DIR)
    : path.join(process.cwd(), "data", "projects");

const normalizeEmail = (value: string | null | undefined) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const projectPath = (projectId: string) => {
  if (!/^[a-zA-Z0-9_-]+$/u.test(projectId)) {
    throw new Error(`Invalid project id: ${projectId}`);
  }
  return path.join(getProjectStoreDir(), `${projectId}${PROJECT_FILE_EXTENSION}`);
};

const sortSummaries = (projects: ProjectSummary[]) =>
  [...projects].sort((a, b) => {
    const updated = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    return updated || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  });

const toStored = (project: ProjectDocument, ownerId: string | null): StoredProject => {
  const { accessRole, attachedMemoryItems, sessionCount, sessions, ...rest } = project;
  void accessRole;
  void attachedMemoryItems;
  void sessionCount;
  void sessions;
  return { ...rest, ownerId };
};

const toDocument = (
  project: StoredProject,
  accessRole: ProjectDocument["accessRole"] = "owner",
): ProjectDocument => {
  const { ownerId, ...rest } = project;
  void ownerId;
  return { ...rest, accessRole, sessionCount: rest.sessionIds.length };
};

const toRecord = (
  project: StoredProject,
  accessRole: ProjectDocument["accessRole"],
): ProjectRecord => {
  if (!project.ownerId) throw new Error("Project not found");
  return { ...toDocument(project, accessRole), ownerId: project.ownerId };
};

const normalizeMembers = (members: ProjectMember[]) =>
  members
    .map((member) => {
      const email = normalizeEmail(member.email);
      if (!email) return null;
      const addedAt = member.addedAt || new Date().toISOString();
      const invitationId = member.invitationId ?? null;
      const acceptedAt = member.acceptedAt ?? (!invitationId ? addedAt : null);
      return {
        acceptedAt,
        addedAt,
        email,
        invitationId,
        role: member.role,
        status: acceptedAt ? "accepted" as const : "pending" as const,
        userId: member.userId ?? null,
      };
    })
    .filter((member): member is ProjectMember => member !== null)
    .sort((a, b) => a.email.localeCompare(b.email));

const ensureDir = () => fs.mkdir(getProjectStoreDir(), { recursive: true });

const writeProject = async (project: StoredProject) => {
  await ensureDir();
  const destination = projectPath(project.id);
  const temporary = `${destination}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(project, null, 2), "utf8");
  await fs.rename(temporary, destination);
};

const readProject = async (filePath: string): Promise<StoredProject> => {
  const raw = await fs.readFile(filePath, "utf8");
  const json = JSON.parse(raw) as { ownerId?: unknown };
  const parsed = normalizeProjectDocument(json);
  if (!parsed) throw new Error(`Invalid project document: ${filePath}`);
  return toStored(
    { ...parsed, members: normalizeMembers(parsed.members) },
    typeof json.ownerId === "string" && json.ownerId.length > 0 ? json.ownerId : null,
  );
};

const readAll = async () => {
  await ensureDir();
  const entries = await fs.readdir(getProjectStoreDir(), { withFileTypes: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(PROJECT_FILE_EXTENSION))
      .map((entry) => readProject(path.join(getProjectStoreDir(), entry.name))),
  );
};

const claimOwner = async (project: StoredProject, ownerId: string) => {
  if (project.ownerId === ownerId) return project;
  if (project.ownerId) return null;
  const claimed = { ...project, ownerId };
  await writeProject(claimed);
  return claimed;
};

const getStored = async (projectId: string, ownerId?: string) => {
  const project = await readProject(projectPath(projectId));
  if (!ownerId) return project;
  const claimed = await claimOwner(project, ownerId);
  if (!claimed) throw new Error("Project not found");
  return claimed;
};

const actorRole = (project: StoredProject, actor: ProjectActor) => {
  if (!project.ownerId && actor.claimLegacyOwnership === false) return "owner" as const;
  if (project.ownerId === actor.userId) return "owner" as const;
  const email = normalizeEmail(actor.userEmail);
  const member = project.members.find(
    (entry) =>
      entry.status === "accepted" &&
      (entry.userId === actor.userId ||
        (entry.userId === null && email !== null && entry.email === email)),
  );
  return member?.role ?? null;
};

const summary = (
  project: StoredProject,
  accessRole: ProjectDocument["accessRole"],
): ProjectSummary => {
  const document = toDocument(project, accessRole);
  return {
    accessRole,
    arenaWinnerBranchKey: document.arenaWinnerBranchKey,
    arenaWinnerSessionId: document.arenaWinnerSessionId,
    createdAt: document.createdAt,
    id: document.id,
    memoryIds: document.memoryIds,
    sessionCount: document.sessionCount,
    title: document.title,
    updatedAt: document.updatedAt,
  };
};

export const fileProjectRepositoryV2: ProjectRepository = {
  async listProjects(options = {}) {
    const ownerId = options.ownerId || null;
    const visible: StoredProject[] = [];
    for (const project of await readAll()) {
      if (!ownerId) {
        visible.push(project);
      } else {
        const claimed = await claimOwner(project, ownerId);
        if (claimed) visible.push(claimed);
      }
    }
    return sortSummaries(visible.map((project) => summary(project, "owner")));
  },

  async listProjectsForActor(actor) {
    const visible: ProjectSummary[] = [];
    for (const project of await readAll()) {
      const claimed = actor.claimLegacyOwnership === false
        ? null
        : await claimOwner(project, actor.userId);
      const current = claimed ?? project;
      const role = actorRole(current, actor);
      if (role) visible.push(summary(current, role));
    }
    return sortSummaries(visible);
  },

  async getProject(projectId, ownerId) {
    return toDocument(await getStored(projectId, ownerId), "owner");
  },

  async getProjectRecordForActor(projectId, actor) {
    const project = await readProject(projectPath(projectId));
    const claimed = actor.claimLegacyOwnership === false
      ? null
      : await claimOwner(project, actor.userId);
    const current = claimed ?? project;
    const role = actorRole(current, actor);
    if (!role) throw new Error("Project not found");
    if (!current.ownerId && actor.claimLegacyOwnership === false) {
      return { ...toDocument(current, role), ownerId: actor.userId };
    }
    return toRecord(current, role);
  },

  async createProject(input: ProjectCreateInput = {}) {
    const now = new Date().toISOString();
    const project: StoredProject = {
      arenaWinnerBranchKey: null,
      arenaWinnerSessionId: null,
      createdAt: now,
      globalContext: typeof input.globalContext === "string" ? input.globalContext : "",
      id: randomUUID(),
      map: normalizeProjectMap(input.map),
      memoryIds: [...new Set(input.memoryIds ?? [])],
      members: [],
      ownerId: input.ownerId ?? null,
      sessionIds: [...new Set(input.sessionIds ?? [])],
      title: typeof input.title === "string" && input.title.trim() ? input.title.trim() : null,
      updatedAt: now,
    };
    await writeProject(project);
    return toDocument(project, "owner");
  },

  async patchProject(projectId, patch: ProjectPatch, ownerId) {
    const current = await getStored(projectId, ownerId);
    const next: StoredProject = {
      ...current,
      arenaWinnerBranchKey: patch.arenaWinnerBranchKey === undefined ? current.arenaWinnerBranchKey : patch.arenaWinnerBranchKey,
      arenaWinnerSessionId: patch.arenaWinnerSessionId === undefined ? current.arenaWinnerSessionId : patch.arenaWinnerSessionId,
      globalContext: patch.globalContext === undefined ? current.globalContext : patch.globalContext,
      map: patch.map === undefined ? current.map : normalizeProjectMap(patch.map),
      memoryIds: patch.memoryIds === undefined ? current.memoryIds : [...new Set(patch.memoryIds)],
      sessionIds: patch.sessionIds === undefined ? current.sessionIds : [...new Set(patch.sessionIds)],
      title: patch.title === undefined ? current.title : typeof patch.title === "string" && patch.title.trim() ? patch.title.trim() : null,
      updatedAt: new Date().toISOString(),
    };
    await writeProject(next);
    return toDocument(next, "owner");
  },

  async upsertProjectMember(projectId, member: ProjectMemberInput, ownerId) {
    const current = await getStored(projectId, ownerId);
    const email = normalizeEmail(member.email);
    if (!email) throw new Error("A valid member email is required");
    const existing = current.members.find((entry) => entry.email === email);
    const addedAt = existing?.addedAt ?? new Date().toISOString();
    const invitationId = member.invitationId === undefined ? existing?.invitationId ?? null : member.invitationId;
    const acceptedAt = member.acceptedAt === undefined
      ? existing?.acceptedAt ?? (!invitationId ? new Date().toISOString() : null)
      : member.acceptedAt;
    const nextMember: ProjectMember = {
      acceptedAt,
      addedAt,
      email,
      invitationId,
      role: member.role,
      status: acceptedAt ? "accepted" : "pending",
      userId: member.userId === undefined ? existing?.userId ?? null : member.userId,
    };
    const next = {
      ...current,
      members: [...current.members.filter((entry) => entry.email !== email), nextMember]
        .sort((a, b) => a.email.localeCompare(b.email)),
      updatedAt: new Date().toISOString(),
    };
    await writeProject(next);
    return toDocument(next, "owner");
  },

  async removeProjectMember(projectId, memberEmail, ownerId) {
    const current = await getStored(projectId, ownerId);
    const email = normalizeEmail(memberEmail);
    if (!email) throw new Error("A valid member email is required");
    const next = {
      ...current,
      members: current.members.filter((entry) => entry.email !== email),
      updatedAt: new Date().toISOString(),
    };
    await writeProject(next);
    return toDocument(next, "owner");
  },

  async deleteProject(projectId, ownerId) {
    const project = await getStored(projectId, ownerId);
    await fs.rm(projectPath(project.id), { force: true });
  },

  async deleteProjects(projectIds, ownerId) {
    await Promise.all([...new Set(projectIds)].map((id) => fileProjectRepositoryV2.deleteProject(id, ownerId)));
  },
};
