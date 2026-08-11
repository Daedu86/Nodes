import {
  getSessionMessageCount,
  normalizeSessionArtifactsDocument,
  normalizeSessionContextLinksDocument,
  normalizeSessionThreadExport,
  type SessionDocument,
  type SessionSummary,
} from "@/lib/session-documents";
import type {
  ProjectAccessRole,
  ProjectCollaboratorRole,
  ProjectDocument,
  ProjectMember,
  ProjectSummary,
} from "@/lib/project-documents";
import { normalizeProjectMap } from "@/lib/project-map";
import { type ProjectMemoryItem, normalizeProjectMemoryItem } from "@/lib/memory-documents";
import type {
  SessionBlobCleanupResult,
  SessionBlobMaintenance,
} from "@/lib/session-blob-store";
import type { ProjectRecord } from "@/lib/persistence/project-repository";
import { isValidSessionVersion } from "@/lib/session-version-conflict";
import {
  resolveMaterializedMessageCount,
  resolveSessionSchemaVersion,
} from "@/lib/persistence/session-schema-version";

export const emptyBlobMaintenance = (): SessionBlobMaintenance => ({
  deduplicatedBlobLinks: 0,
  orphanBlobCount: 0,
  orphanBytes: 0,
  referencedBlobCount: 0,
  referencedBlobLinks: 0,
  referencedBytes: 0,
  totalBlobCount: 0,
  totalBytes: 0,
  uniqueReferencedBlobCount: 0,
});

export const emptyBlobCleanup = (): SessionBlobCleanupResult => ({
  deletedBlobCount: 0,
  deletedBytes: 0,
  maintenance: emptyBlobMaintenance(),
});

export const requireOwnerId = (ownerId?: string) => {
  if (typeof ownerId === "string" && ownerId.length > 0) {
    return ownerId;
  }
  throw new Error("Supabase persistence requires an authenticated owner id.");
};

export const ensureData = <T>(data: T | null, error: { message?: string } | null, fallback: string) => {
  if (error) {
    throw new Error(error.message || fallback);
  }
  if (data === null) {
    throw new Error(fallback);
  }
  return data;
};

const normalizeSessionVersion = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return isValidSessionVersion(parsed) ? parsed : 1;
};

type SessionRow = {
  archived: boolean;
  artifacts_json?: unknown;
  context_links_json?: unknown;
  created_at: string;
  id: string;
  message_count?: number | string | null;
  schema_version?: number | string | null;
  snapshot_json?: unknown;
  title: string | null;
  updated_at: string;
  version: number | string;
};

export const toSessionDocumentFromRow = (row: SessionRow): SessionDocument => {
  resolveSessionSchemaVersion(row.schema_version);
  const snapshot = normalizeSessionThreadExport(row.snapshot_json);
  return {
    id: row.id,
    title: row.title,
    archived: row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: normalizeSessionVersion(row.version),
    snapshot,
    artifacts: normalizeSessionArtifactsDocument(row.artifacts_json),
    contextLinks: normalizeSessionContextLinksDocument(row.context_links_json),
    messageCount: resolveMaterializedMessageCount(
      row.message_count,
      () => getSessionMessageCount(snapshot),
    ),
  };
};

export const toSessionSummaryFromRow = (row: SessionRow): SessionSummary => {
  resolveSessionSchemaVersion(row.schema_version);
  return {
    id: row.id,
    title: row.title,
    archived: row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: normalizeSessionVersion(row.version),
    messageCount: resolveMaterializedMessageCount(
      row.message_count,
      () => getSessionMessageCount(normalizeSessionThreadExport(row.snapshot_json)),
    ),
  };
};

type ProjectRelationRow = {
  memory_id?: string | null;
  position?: number | null;
  session_id?: string | null;
};

type ProjectMemberRow = {
  accepted_at?: string | null;
  created_at?: string | null;
  invitation_id?: string | null;
  role?: string | null;
  user_email?: string | null;
  user_id?: string | null;
};

type ProjectRow = {
  arena_winner_branch_key: string | null;
  arena_winner_session_id: string | null;
  created_at: string;
  global_context: string;
  id: string;
  map_json?: unknown;
  owner_id?: string | null;
  project_members?: ProjectMemberRow[] | null;
  project_memory_links?: ProjectRelationRow[] | null;
  project_sessions?: ProjectRelationRow[] | null;
  title: string | null;
  updated_at: string;
};

export const toProjectMembersFromRow = (row: ProjectRow): ProjectMember[] =>
  (row.project_members ?? [])
    .flatMap((entry) => {
      const email =
        typeof entry.user_email === "string" && entry.user_email.trim().length > 0
          ? entry.user_email.trim().toLowerCase()
          : null;
      const role =
        entry.role === "editor" || entry.role === "viewer"
          ? (entry.role as ProjectCollaboratorRole)
          : null;
      if (!email || !role) return [];
      const addedAt =
        typeof entry.created_at === "string" && entry.created_at.length > 0
          ? entry.created_at
          : new Date().toISOString();
      const invitationId =
        typeof entry.invitation_id === "string" && entry.invitation_id.length > 0
          ? entry.invitation_id
          : null;
      const userId =
        typeof entry.user_id === "string" && entry.user_id.length > 0
          ? entry.user_id
          : null;
      const acceptedAt =
        typeof entry.accepted_at === "string" && entry.accepted_at.length > 0
          ? entry.accepted_at
          : invitationId
            ? null
            : addedAt;
      return [{
        acceptedAt,
        addedAt,
        email,
        invitationId,
        role,
        status: acceptedAt ? "accepted" as const : "pending" as const,
        userId,
      }];
    })
    .sort((a, b) => a.email.localeCompare(b.email));

export const toProjectDocumentFromRow = (
  row: ProjectRow,
  accessRole: ProjectAccessRole = "owner",
): ProjectDocument => {
  const sessionIds = (row.project_sessions ?? [])
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((entry) => entry.session_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const memoryIds = (row.project_memory_links ?? [])
    .map((entry) => entry.memory_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  return {
    accessRole,
    arenaWinnerBranchKey: row.arena_winner_branch_key,
    arenaWinnerSessionId: row.arena_winner_session_id,
    createdAt: row.created_at,
    globalContext: row.global_context,
    id: row.id,
    map: normalizeProjectMap(row.map_json),
    memoryIds,
    members: toProjectMembersFromRow(row),
    sessionCount: sessionIds.length,
    sessionIds,
    title: row.title,
    updatedAt: row.updated_at,
  };
};

export const toProjectRecordFromRow = (
  row: ProjectRow,
  accessRole: ProjectAccessRole = "owner",
): ProjectRecord => {
  const ownerId =
    typeof row.owner_id === "string" && row.owner_id.length > 0
      ? row.owner_id
      : "";
  if (!ownerId) {
    throw new Error(`Invalid project row missing owner id: ${row.id}`);
  }
  return {
    ...toProjectDocumentFromRow(row, accessRole),
    ownerId,
  };
};

export const toProjectSummaryFromRow = (
  row: ProjectRow,
  accessRole: ProjectAccessRole = "owner",
): ProjectSummary => {
  const document = toProjectDocumentFromRow(row, accessRole);
  return {
    accessRole: document.accessRole,
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

type MemoryRow = {
  content: string;
  created_at: string;
  id: string;
  owner_id: string;
  source_keys: unknown;
  source_kind: string | null;
  source_project_id: string | null;
  source_session_id: string | null;
  title: string;
  type: string;
  updated_at: string;
};

export const toMemoryItemFromRow = (row: MemoryRow): ProjectMemoryItem => {
  const item = normalizeProjectMemoryItem({
    content: row.content,
    createdAt: row.created_at,
    id: row.id,
    sourceProjectId: row.source_project_id,
    sourceKeys: row.source_keys,
    sourceKind: row.source_kind,
    sourceSessionId: row.source_session_id,
    title: row.title,
    type: row.type,
    updatedAt: row.updated_at,
  });
  if (!item) {
    throw new Error(`Invalid memory row: ${row.id}`);
  }
  return item;
};
