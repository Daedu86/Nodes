import {
  createMemoryItem,
  deleteMemoryItems,
  listMemoryItems,
} from "@/lib/memory-store";
import {
  PROJECT_MEMORY_TYPES,
  type ProjectMemorySourceKind,
  type ProjectMemoryType,
} from "@/lib/memory-documents";
import { getProject, patchProject } from "@/lib/project-store";
import { getSession } from "@/lib/session-store";
import { requireLocalApiUser } from "@/lib/server/request-guards";

type CreateMemoryBody = {
  content?: string;
  sourceProjectId?: string | null;
  sourceKeys?: unknown;
  sourceKind?: string | null;
  sourceSessionId?: string | null;
  title?: string | null;
  type?: string;
};

type DeleteMemoryBody = {
  all?: boolean;
  memoryIds?: unknown;
};

export const runtime = "nodejs";

export async function GET(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const items = await listMemoryItems({ ownerId: guarded.user.id });
  return Response.json({ items });
}

export async function POST(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const body = (await req.json().catch(() => ({}))) as CreateMemoryBody;
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  const type = PROJECT_MEMORY_TYPES.includes(body.type as ProjectMemoryType)
    ? (body.type as ProjectMemoryType)
    : "summary";

  if (!title || !content.trim()) {
    return new Response("Title and content are required", { status: 400 });
  }

  const sourceProjectId =
    typeof body.sourceProjectId === "string" && body.sourceProjectId.length > 0
      ? body.sourceProjectId
      : null;
  const sourceSessionId =
    typeof body.sourceSessionId === "string" && body.sourceSessionId.length > 0
      ? body.sourceSessionId
      : null;

  let resolvedProject: Awaited<ReturnType<typeof getProject>> | null = null;
  if (sourceProjectId) {
    try {
      resolvedProject = await getProject(sourceProjectId, guarded.user.id);
    } catch {
      resolvedProject = null;
    }
  }

  let resolvedSessionId: string | null = null;
  if (sourceSessionId) {
    try {
      const session = await getSession(sourceSessionId, guarded.user.id);
      resolvedSessionId = session.id;
    } catch {
      resolvedSessionId = null;
    }
  }

  const item = await createMemoryItem({
    content,
    ownerId: guarded.user.id,
    sourceProjectId: resolvedProject?.id ?? null,
    sourceKeys: Array.isArray(body.sourceKeys)
      ? body.sourceKeys.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [],
    sourceKind:
      body.sourceKind === "session" || body.sourceKind === "branch"
        ? (body.sourceKind as ProjectMemorySourceKind)
        : null,
    sourceSessionId: resolvedSessionId,
    title,
    type,
  });

  if (resolvedProject) {
    const currentProject = await getProject(resolvedProject.id, guarded.user.id);
    if (!currentProject.memoryIds.includes(item.id)) {
      await patchProject(
        currentProject.id,
        { memoryIds: [...currentProject.memoryIds, item.id] },
        guarded.user.id,
      );
    }
  }

  return Response.json({ item }, { status: 201 });
}

export async function DELETE(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const body = (await req.json().catch(() => ({}))) as DeleteMemoryBody;
  const deleteAll = body.all === true;
  const requestedIds = Array.isArray(body.memoryIds)
    ? body.memoryIds.filter((value): value is string => typeof value === "string" && value.length > 0)
    : [];
  const memoryIds = deleteAll
    ? (await listMemoryItems({ ownerId: guarded.user.id })).map((item) => item.id)
    : [...new Set(requestedIds)];

  if (memoryIds.length === 0) {
    return new Response("No memory selected", { status: 400 });
  }

  await deleteMemoryItems(memoryIds, guarded.user.id);
  return Response.json({ deletedIds: memoryIds });
}