import {
  deleteProjects as deleteProjectBatch,
  listProjects,
} from "@/lib/project-store";
import {
  createProjectForUser,
  listProjectsForUser,
} from "@/lib/project-collaboration";
import { createDefaultProjectMap } from "@/lib/project-documents";
import { listMemoryItems } from "@/lib/memory-store";
import { listSessions } from "@/lib/session-store";
import { requireLocalApiUser } from "@/lib/server/request-guards";
import { recordAgentEvent } from "@/lib/server/agent-work";

type CreateProjectBody = {
  memoryIds?: unknown;
  globalContext?: string;
  sessionIds?: unknown;
  title?: string | null;
};

type DeleteProjectsBody = {
  all?: boolean;
  projectIds?: unknown;
};

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const projects = await listProjectsForUser(guarded.user);
  return Response.json({ projects });
}

export async function POST(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const body = (await req.json().catch(() => ({}))) as CreateProjectBody;
  const requestedSessionIds = Array.isArray(body.sessionIds)
    ? body.sessionIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const requestedMemoryIds = Array.isArray(body.memoryIds)
    ? body.memoryIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const [sessions, memoryItems] = await Promise.all([
    listSessions({ includeArchived: true, ownerId: guarded.user.id }),
    listMemoryItems({ ownerId: guarded.user.id }),
  ]);
  const allowedSessionIds = new Set(sessions.map((session) => session.id));
  const allowedMemoryIds = new Set(memoryItems.map((item) => item.id));
  const sessionIds = requestedSessionIds.filter((sessionId) => allowedSessionIds.has(sessionId));
  const memoryIds = requestedMemoryIds.filter((memoryId) => allowedMemoryIds.has(memoryId));
  const requestedMap = typeof body.globalContext === "string" ? body.globalContext.trim() : "";
  const project = await createProjectForUser({
    globalContext: requestedMap || createDefaultProjectMap(body.title ?? null),
    memoryIds,
    sessionIds,
    title: body.title ?? null,
  }, guarded.user);

  if (guarded.user.isAgent) {
    await recordAgentEvent({
      actor: {
        ownerId: guarded.user.id,
        tokenId: guarded.user.agentTokenId ?? null,
        label: guarded.user.agentLabel ?? null,
      },
      eventType: "project.created",
      method: "POST",
      route: "/api/projects",
      projectId: project.id,
      payload: { sessionIds, memoryIds },
    });
  }
  return Response.json({ project }, { status: 201 });
}

export async function DELETE(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const body = (await req.json().catch(() => ({}))) as DeleteProjectsBody;
  const deleteAll = body.all === true;
  const requestedIds = Array.isArray(body.projectIds)
    ? body.projectIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const projectIds = deleteAll
    ? (await listProjects({ ownerId: guarded.user.id })).map((project) => project.id)
    : [...new Set(requestedIds)];

  if (projectIds.length === 0) {
    return new Response("No projects selected", { status: 400 });
  }

  await deleteProjectBatch(projectIds, guarded.user.id);
  return Response.json({ deletedIds: projectIds });
}
