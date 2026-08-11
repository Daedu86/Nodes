import type {
  ProjectActor,
  ProjectMemberInput,
  ProjectRepository,
} from "@/lib/persistence/project-repository";
import type { ProjectSummary } from "@/lib/project-documents";
import { getProjectMapSessionIds, normalizeProjectMap } from "@/lib/project-map";
import { getSupabasePersistenceClient } from "@/lib/persistence/supabase/client";
import {
  ensureData,
  requireOwnerId,
  toProjectDocumentFromRow,
  toProjectMembersFromRow,
  toProjectRecordFromRow,
  toProjectSummaryFromRow,
} from "@/lib/persistence/supabase/shared";

const projectSelect = `
  id,
  owner_id,
  title,
  global_context,
  map_json,
  arena_winner_session_id,
  arena_winner_branch_key,
  created_at,
  updated_at,
  project_sessions(session_id, position),
  project_memory_links(memory_id),
  project_members(user_email, user_id, role, accepted_at, invitation_id, created_at)
`;

const sortProjectSummaries = (projects: ProjectSummary[]) =>
  [...projects].sort((a, b) => {
    const updatedDelta = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (updatedDelta !== 0) return updatedDelta;
    const createdDelta = b.createdAt.localeCompare(a.createdAt);
    if (createdDelta !== 0) return createdDelta;
    return a.id.localeCompare(b.id);
  });

const normalizeMemberEmail = (value: string | null | undefined) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

async function fetchProjectRow(projectId: string) {
  const client = getSupabasePersistenceClient();
  const { data, error } = await client
    .from("projects")
    .select(projectSelect)
    .eq("id", projectId)
    .maybeSingle();

  return ensureData(data, error, "Project not found");
}

async function replaceProjectSessionLinks(projectId: string, sessionIds: string[]) {
  const client = getSupabasePersistenceClient();
  await client.from("project_sessions").delete().eq("project_id", projectId);
  if (sessionIds.length === 0) return;
  const rows = sessionIds.map((sessionId, index) => ({
    project_id: projectId,
    session_id: sessionId,
    position: index,
  }));
  const { error } = await client.from("project_sessions").insert(rows);
  if (error) throw new Error(error.message || "Failed to update project sessions");
}

async function replaceProjectMemoryLinks(projectId: string, memoryIds: string[]) {
  const client = getSupabasePersistenceClient();
  await client.from("project_memory_links").delete().eq("project_id", projectId);
  if (memoryIds.length === 0) return;
  const rows = memoryIds.map((memoryId) => ({
    project_id: projectId,
    memory_id: memoryId,
  }));
  const { error } = await client.from("project_memory_links").insert(rows);
  if (error) throw new Error(error.message || "Failed to update project memory");
}

const loadMembershipRoles = async (actor: ProjectActor) => {
  const client = getSupabasePersistenceClient();
  const roleByProjectId = new Map<string, "editor" | "viewer">();
  const { data: userRows, error: userError } = await client
    .from("project_members")
    .select("project_id, role")
    .eq("user_id", actor.userId)
    .not("accepted_at", "is", null);
  if (userError) throw new Error(userError.message || "Failed to list shared projects");
  for (const row of userRows ?? []) {
    if (typeof row.project_id !== "string") continue;
    if (row.role !== "editor" && row.role !== "viewer") continue;
    roleByProjectId.set(row.project_id, row.role);
  }

  const memberEmail = normalizeMemberEmail(actor.userEmail);
  if (memberEmail) {
    const { data: legacyRows, error: legacyError } = await client
      .from("project_members")
      .select("project_id, role")
      .eq("user_email", memberEmail)
      .is("user_id", null)
      .not("accepted_at", "is", null);
    if (legacyError) throw new Error(legacyError.message || "Failed to list legacy shared projects");
    for (const row of legacyRows ?? []) {
      if (typeof row.project_id !== "string" || roleByProjectId.has(row.project_id)) continue;
      if (row.role !== "editor" && row.role !== "viewer") continue;
      roleByProjectId.set(row.project_id, row.role);
    }
  }
  return roleByProjectId;
};

export const supabaseProjectRepository: ProjectRepository = {
  async listProjects(options = {}) {
    const client = getSupabasePersistenceClient();
    const { data, error } = await client
      .from("projects")
      .select(projectSelect)
      .eq("owner_id", requireOwnerId(options.ownerId))
      .order("updated_at", { ascending: false });
    const rows = ensureData(data, error, "Failed to list projects");
    return rows.map((row) => toProjectSummaryFromRow(row, "owner"));
  },

  async listProjectsForActor(actor) {
    const client = getSupabasePersistenceClient();
    const ownerId = requireOwnerId(actor.userId);
    const { data: ownData, error: ownError } = await client
      .from("projects")
      .select(projectSelect)
      .eq("owner_id", ownerId)
      .order("updated_at", { ascending: false });
    const ownRows = ensureData(ownData, ownError, "Failed to list projects");
    const ownProjectIds = new Set(ownRows.map((row) => row.id));
    const ownProjects = ownRows.map((row) => toProjectSummaryFromRow(row, "owner"));
    const roleByProjectId = await loadMembershipRoles(actor);
    const sharedIds = [...roleByProjectId.keys()].filter((projectId) => !ownProjectIds.has(projectId));
    if (sharedIds.length === 0) return ownProjects;
    const { data: sharedData, error: sharedError } = await client
      .from("projects")
      .select(projectSelect)
      .in("id", sharedIds);
    const sharedRows = ensureData(sharedData, sharedError, "Failed to load shared projects");
    const sharedProjects = sharedRows.map((row) =>
      toProjectSummaryFromRow(row, roleByProjectId.get(row.id) ?? "viewer"),
    );
    return sortProjectSummaries([...ownProjects, ...sharedProjects]);
  },

  async getProject(projectId, ownerId) {
    const client = getSupabasePersistenceClient();
    const { data, error } = await client
      .from("projects")
      .select(projectSelect)
      .eq("id", projectId)
      .eq("owner_id", requireOwnerId(ownerId))
      .maybeSingle();
    const row = ensureData(data, error, "Project not found");
    return toProjectDocumentFromRow(row, "owner");
  },

  async getProjectRecordForActor(projectId, actor: ProjectActor) {
    const row = await fetchProjectRow(projectId);
    const ownerId = requireOwnerId(actor.userId);
    if (row.owner_id === ownerId) return toProjectRecordFromRow(row, "owner");
    const memberEmail = normalizeMemberEmail(actor.userEmail);
    const member = toProjectMembersFromRow(row).find((entry) =>
      entry.status === "accepted" &&
      (entry.userId === actor.userId ||
        (entry.userId === null && memberEmail !== null && entry.email === memberEmail)),
    );
    if (!member) throw new Error("Project not found");
    return toProjectRecordFromRow(row, member.role);
  },

  async createProject(input = {}) {
    const client = getSupabasePersistenceClient();
    const ownerId = requireOwnerId(input.ownerId);
    const map = normalizeProjectMap(input.map);
    const mapSessionIds = getProjectMapSessionIds(map);
    const sessionIds = map.nodes.length > 0
      ? mapSessionIds
      : Array.isArray(input.sessionIds)
        ? [...new Set(input.sessionIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))]
        : [];
    const memoryIds = Array.isArray(input.memoryIds)
      ? [...new Set(input.memoryIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))]
      : [];
    const { data, error } = await client
      .from("projects")
      .insert({
        owner_id: ownerId,
        title: typeof input.title === "string" && input.title.trim().length > 0 ? input.title.trim() : null,
        global_context: typeof input.globalContext === "string" ? input.globalContext : "",
        map_json: map,
      })
      .select("id")
      .single();
    const created = ensureData(data, error, "Failed to create project");
    await replaceProjectSessionLinks(created.id, sessionIds);
    await replaceProjectMemoryLinks(created.id, memoryIds);
    return this.getProject(created.id, ownerId);
  },

  async patchProject(projectId, patch, ownerId) {
    const client = getSupabasePersistenceClient();
    const update: Record<string, unknown> = {};
    let mapSessionIds: string[] | null = null;
    if (patch.title !== undefined) {
      update.title = typeof patch.title === "string" && patch.title.trim().length > 0 ? patch.title.trim() : null;
    }
    if (patch.globalContext !== undefined) update.global_context = patch.globalContext;
    if (patch.arenaWinnerBranchKey !== undefined) update.arena_winner_branch_key = patch.arenaWinnerBranchKey;
    if (patch.arenaWinnerSessionId !== undefined) update.arena_winner_session_id = patch.arenaWinnerSessionId;
    if (patch.map !== undefined) {
      const map = normalizeProjectMap(patch.map);
      update.map_json = map;
      mapSessionIds = getProjectMapSessionIds(map);
    }
    if (Object.keys(update).length > 0) {
      const { error } = await client
        .from("projects")
        .update(update)
        .eq("id", projectId)
        .eq("owner_id", requireOwnerId(ownerId));
      if (error) throw new Error(error.message || "Failed to update project");
    }
    if (mapSessionIds !== null) {
      await replaceProjectSessionLinks(projectId, mapSessionIds);
    } else if (patch.sessionIds !== undefined) {
      await replaceProjectSessionLinks(projectId, [...new Set(patch.sessionIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))]);
    }
    if (patch.memoryIds !== undefined) {
      await replaceProjectMemoryLinks(projectId, [...new Set(patch.memoryIds.filter((entry): entry is string => typeof entry === "string" && entry.length > 0))]);
    }
    return this.getProject(projectId, requireOwnerId(ownerId));
  },

  async upsertProjectMember(projectId, member: ProjectMemberInput, ownerId) {
    const client = getSupabasePersistenceClient();
    const normalizedEmail = normalizeMemberEmail(member.email);
    if (!normalizedEmail) throw new Error("A valid member email is required");
    await this.getProject(projectId, ownerId);
    const { error } = await client
      .from("project_members")
      .upsert(
        {
          accepted_at: member.acceptedAt === undefined ? new Date().toISOString() : member.acceptedAt,
          invitation_id: member.invitationId ?? null,
          project_id: projectId,
          role: member.role,
          user_email: normalizedEmail,
          user_id: member.userId ?? null,
        },
        { onConflict: "project_id,user_email" },
      );
    if (error) throw new Error(error.message || "Failed to update project members");
    return this.getProject(projectId, requireOwnerId(ownerId));
  },

  async removeProjectMember(projectId, memberEmail, ownerId) {
    const client = getSupabasePersistenceClient();
    const normalizedEmail = normalizeMemberEmail(memberEmail);
    if (!normalizedEmail) throw new Error("A valid member email is required");
    await this.getProject(projectId, ownerId);
    const { error } = await client
      .from("project_members")
      .delete()
      .eq("project_id", projectId)
      .eq("user_email", normalizedEmail);
    if (error) throw new Error(error.message || "Failed to remove project member");
    return this.getProject(projectId, requireOwnerId(ownerId));
  },

  async deleteProject(projectId, ownerId) {
    const client = getSupabasePersistenceClient();
    const { error } = await client.from("projects").delete().eq("id", projectId).eq("owner_id", requireOwnerId(ownerId));
    if (error) throw new Error(error.message || "Failed to delete project");
  },

  async deleteProjects(projectIds, ownerId) {
    const client = getSupabasePersistenceClient();
    const { error } = await client.from("projects").delete().in("id", [...new Set(projectIds)]).eq("owner_id", requireOwnerId(ownerId));
    if (error) throw new Error(error.message || "Failed to delete projects");
  },
};
