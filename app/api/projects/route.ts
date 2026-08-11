import {
  deleteProjects as deleteProjectBatch,
  listProjects,
} from "@/lib/project-store";
import {
  createProjectForUser,
  listProjectsForUser,
} from "@/lib/project-collaboration";
import { filterProjectMapSessions, getProjectMapSessionIds, normalizeProjectMap } from "@/lib/project-map";
import { createProjectMapForTitle } from "@/lib/project-map-templates";
import { listMemoryItems } from "@/lib/memory-store";
import { listSessions } from "@/lib/session-store";
import { requireLocalApiUser } from "@/lib/server/request-guards";
import { recordAgentEvent } from "@/lib/server/agent-work";

type CreateProjectBody = {
  memoryIds?: unknown;
  globalContext?: string;
  map?: unknown;
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
  const validRequestedSessionIds = requestedSessionIds.filter((sessionId) => allowedSessionIds.has(sessionId));
  const requestedMap = filterProjectMapSessions(body.map, allowedSessionIds);
  const seededMap = body.map === undefined
    ? createProjectMapForTitle(body.title ?? null)
    : requestedMap;
  const map = seededMap.nodes.length > 0 && validRequestedSessionIds.length > 0 && getProjectMapSessionIds(seededMap).length === 0
    ? normalizeProjectMap({
        ...seededMap,
        nodes: seededMap.nodes.map((node, index) =>
          index === 0
            ? {
                ...node,
                primarySessionId: validRequestedSessionIds[0] ?? null,
                sessionIds: validRequestedSessionIds,
                status: "ready",
              }
            : node,
        ),
      })
    : seededMap;
  const sessionIds = getProjectMapSessionIds(map);
  const memoryIds = requestedMemoryIds.filter((memoryId) => allowedMemoryIds.has(memoryId));
  const project = await createProjectForUser({
    globalContext: typeof body.globalContext === "string" ? body.globalContext : "",
    map,
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
      payload: { sessionIds, memoryIds, mapNodeCount: map.nodes.length },
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
