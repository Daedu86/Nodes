import {
  getProjectForUser,
  patchProjectForUser,
  ProjectAccessError,
} from "@/lib/project-collaboration";
import {
  filterProjectMapSessions,
  getProjectMapSessionIds,
  normalizeProjectMap,
  type ProjectMap,
} from "@/lib/project-map";
import { listMemoryItems } from "@/lib/memory-store";
import { listSessions } from "@/lib/session-store";
import { requireLocalApiUser } from "@/lib/server/request-guards";
import { notifyProjectAccessed } from "@/lib/server/project-notifications";

type RouteParams = {
  params: Promise<{
    projectId: string;
  }>;
};

type PatchProjectBody = {
  arenaWinnerBranchKey?: string | null;
  arenaWinnerSessionId?: string | null;
  globalContext?: string;
  map?: unknown;
  memoryIds?: unknown;
  sessionIds?: unknown;
  title?: string | null;
};

export const runtime = "nodejs";

const applyLegacySessionListToMap = (
  map: ProjectMap,
  requestedSessionIds: string[],
  sessionTitleById: ReadonlyMap<string, string | null>,
) => {
  const requested = new Set(requestedSessionIds);
  const existing = new Set(getProjectMapSessionIds(map));
  const nodes = map.nodes.map((node) => {
    const sessionIds = node.sessionIds.filter((sessionId) => requested.has(sessionId));
    return {
      ...node,
      primarySessionId:
        node.primarySessionId && sessionIds.includes(node.primarySessionId)
          ? node.primarySessionId
          : sessionIds[0] ?? null,
      selectedOutput:
        node.selectedOutput && sessionIds.includes(node.selectedOutput.sessionId)
          ? node.selectedOutput
          : null,
      sessionIds,
      status: sessionIds.length === 0 && node.status === "ready" ? "planned" as const : node.status,
    };
  });

  requestedSessionIds.forEach((sessionId) => {
    if (existing.has(sessionId)) return;
    const baseId = `session-${sessionId}`;
    let id = baseId;
    let suffix = 2;
    while (nodes.some((node) => node.id === id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    nodes.push({
      description: "Session added from the project Sessions panel. Refine or move it from the project map editor.",
      id,
      primarySessionId: sessionId,
      selectedOutput: null,
      sessionIds: [sessionId],
      status: "ready" as const,
      title: sessionTitleById.get(sessionId)?.trim() || "Session workload",
    });
  });

  return normalizeProjectMap({ ...map, nodes });
};

export async function GET(req: Request, context: RouteParams) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const { projectId } = await context.params;
  try {
    const project = await getProjectForUser(projectId, guarded.user);
    await notifyProjectAccessed({
      project,
      accessor: guarded.user,
    });
    return Response.json({ project });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return new Response(error.message, { status: error.status });
    }
    return new Response("Project not found", { status: 404 });
  }
}

export async function PATCH(req: Request, context: RouteParams) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const { projectId } = await context.params;
  const body = (await req.json().catch(() => ({}))) as PatchProjectBody;
  try {
    const currentProject = await getProjectForUser(projectId, guarded.user);
    const canManageStructure = currentProject.accessRole === "owner";
    const [sessions, memoryItems] = canManageStructure
      ? await Promise.all([
        listSessions({ includeArchived: true, ownerId: guarded.user.id }),
        listMemoryItems({ ownerId: guarded.user.id }),
      ])
      : [[], []];
    const allowedSessionIds = new Set(sessions.map((session) => session.id));
    const allowedMemoryIds = new Set(memoryItems.map((item) => item.id));
    const sessionTitleById = new Map(
      sessions.map((session) => [session.id, session.title] as const),
    );
    const currentMap = normalizeProjectMap(currentProject.map);
    let nextMap = body.map === undefined
      ? undefined
      : filterProjectMapSessions(body.map, allowedSessionIds);

    const requestedLegacySessionIds = Array.isArray(body.sessionIds)
      ? [...new Set(
        body.sessionIds
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .filter((value) => allowedSessionIds.has(value)),
      )]
      : null;

    if (
      nextMap === undefined &&
      currentMap.nodes.length > 0 &&
      requestedLegacySessionIds !== null
    ) {
      nextMap = applyLegacySessionListToMap(
        currentMap,
        requestedLegacySessionIds,
        sessionTitleById,
      );
    }

    const nextMapSessionIds = nextMap ? new Set(getProjectMapSessionIds(nextMap)) : null;
    const allowedArenaSessionIds = nextMapSessionIds ?? new Set(currentProject.sessionIds);

    const project = await patchProjectForUser(projectId, {
      arenaWinnerSessionId:
        body.arenaWinnerSessionId === undefined
          ? nextMapSessionIds && currentProject.arenaWinnerSessionId && !nextMapSessionIds.has(currentProject.arenaWinnerSessionId)
            ? null
            : undefined
          : typeof body.arenaWinnerSessionId === "string" && body.arenaWinnerSessionId.length > 0
            && allowedArenaSessionIds.has(body.arenaWinnerSessionId)
            ? body.arenaWinnerSessionId
            : null,
      arenaWinnerBranchKey:
        body.arenaWinnerBranchKey === undefined
          ? undefined
          : typeof body.arenaWinnerBranchKey === "string" && body.arenaWinnerBranchKey.length > 0
            ? body.arenaWinnerBranchKey
            : null,
      globalContext:
        body.globalContext === undefined
          ? undefined
          : typeof body.globalContext === "string"
            ? body.globalContext
            : "",
      map: nextMap,
      memoryIds: Array.isArray(body.memoryIds)
        ? body.memoryIds
          .filter((value): value is string => typeof value === "string" && value.length > 0)
          .filter((value) => allowedMemoryIds.has(value))
        : undefined,
      sessionIds: nextMap
        ? undefined
        : requestedLegacySessionIds ?? undefined,
      title: body.title ?? undefined,
    }, guarded.user);
    return Response.json({ project });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return new Response(error.message, { status: error.status });
    }
    return new Response("Project not found", { status: 404 });
  }
}
