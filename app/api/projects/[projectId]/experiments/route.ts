import { getProjectForUser, ProjectAccessError } from "@/lib/project-collaboration";
import { buildProjectArenaExperimentEntries } from "@/lib/project-arena-experiments";
import { listProjectExperimentRuns } from "@/lib/server/agent-experiment-store";
import { requireLocalApiUser } from "@/lib/server/request-guards";

type RouteParams = {
  params: Promise<{ projectId: string }>;
};

export const runtime = "nodejs";

/**
 * Experiment journals are owner-bound agent evidence. Collaborators may compare
 * normal project sessions, but only the project owner can currently inspect the
 * underlying agent experiment telemetry through this endpoint.
 */
export async function GET(req: Request, context: RouteParams) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;
  const { projectId } = await context.params;

  try {
    const project = await getProjectForUser(projectId, guarded.user);
    if (project.accessRole !== "owner") {
      return new Response("Only the project owner can inspect agent experiments.", { status: 403 });
    }
    const records = await listProjectExperimentRuns({
      ownerId: guarded.user.id,
      projectId,
    });
    return Response.json({
      records,
      entries: buildProjectArenaExperimentEntries(records),
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return new Response(error.message, { status: error.status });
    }
    return new Response("Project experiments unavailable", { status: 404 });
  }
}
