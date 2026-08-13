import type {
  ProjectCollaboratorRole,
  ProjectDocument,
  ProjectSummary,
} from "@/lib/project-documents";
import type { ProjectMap } from "@/lib/project-map";

export type ProjectActor = {
  claimLegacyOwnership?: boolean;
  userEmail: string | null;
  userId: string;
};

export type ProjectRecord = ProjectDocument & {
  ownerId: string;
};

export type ProjectListOptions = {
  ownerId?: string;
};

export type ProjectCreateInput = {
  globalContext?: string;
  map?: ProjectMap;
  memoryIds?: string[];
  ownerId?: string;
  sessionIds?: string[];
  title?: string | null;
};

export type ProjectPatch = {
  arenaWinnerBranchKey?: string | null;
  arenaWinnerSessionId?: string | null;
  globalContext?: string;
  map?: ProjectMap;
  memoryIds?: string[];
  sessionIds?: string[];
  title?: string | null;
};

export type ProjectMemberInput = {
  acceptedAt?: string | null;
  email: string;
  invitationId?: string | null;
  role: ProjectCollaboratorRole;
  userId?: string | null;
};

export interface ProjectRepository {
  createProject(input?: ProjectCreateInput): Promise<ProjectDocument>;
  deleteProject(projectId: string, ownerId?: string): Promise<void>;
  deleteProjects(projectIds: string[], ownerId?: string): Promise<void>;
  getProject(projectId: string, ownerId?: string): Promise<ProjectDocument>;
  getProjectRecordForActor(projectId: string, actor: ProjectActor): Promise<ProjectRecord>;
  listProjects(options?: ProjectListOptions): Promise<ProjectSummary[]>;
  listProjectsForActor(actor: ProjectActor): Promise<ProjectSummary[]>;
  patchProject(projectId: string, patch: ProjectPatch, ownerId?: string): Promise<ProjectDocument>;
  removeProjectMember(projectId: string, memberEmail: string, ownerId?: string): Promise<ProjectDocument>;
  upsertProjectMember(projectId: string, member: ProjectMemberInput, ownerId?: string): Promise<ProjectDocument>;
}
