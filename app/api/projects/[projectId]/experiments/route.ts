import { getAgentHandle } from "@/lib/agents/runtime/handle";
import { markExperimentRunCancelled } from "@/lib/agent-experiments";
import { getProjectForUser, ProjectAccessError } from "@/lib/project-collaboration";
import {
  buildProjectArenaExperimentEntries,
  buildProjectArenaPromotion,
} from "@/lib/project-arena-experiments";
import {
  listProjectExperimentRuns,
  persistExperimentRun,
} from "@/lib/server/agent-experiment-store";
import { requireLocalApiUser } from "@/lib/server/request-guards";

type RouteParams = {
  params: Promise<{ projectId: string }>;
};

type ExperimentControlRequest = {
  action?: unknown;
  experimentId?: unknown;
  candidateId?: unknown;
};

export const runtime = "nodejs";

async function requireOwnedProject(
  projectId: string,
  user: Parameters<typeof getProjectForUser>[1],
) {
  const project = await getProjectForUser(projectId, user);
  if (project.accessRole !== "owner") {
    throw new ProjectAccessError(
      "Only the project owner can control agent experiments.",
      403,
    );
  }
  return project;
}

/**
 * Experiment journals are owner-bound agent evidence. Collaborators may compare
 * normal project sessions, but only the project owner can currently inspect or
 * control the underlying agent experiment telemetry through this endpoint.
 */
export async function GET(req: Request, context: RouteParams) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;
  const { projectId } = await context.params;

  try {
    await requireOwnedProject(projectId, guarded.user);
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

export async function POST(req: Request, context: RouteParams) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;
  const { projectId } = await context.params;
  const body = (await req.json().catch(() => null)) as ExperimentControlRequest | null;
  const action = typeof body?.action === "string" ? body.action.trim() : "";
  const experimentId =
    typeof body?.experimentId === "string" ? body.experimentId.trim() : "";
  const candidateId =
    typeof body?.candidateId === "string" ? body.candidateId.trim() : "";

  if (!experimentId || !["promote-best", "cancel-candidate"].includes(action)) {
    return Response.json(
      {
        error:
          "Expected action 'promote-best' or 'cancel-candidate' and a non-empty experimentId.",
      },
      { status: 400 },
    );
  }
  if (action === "cancel-candidate" && !candidateId) {
    return Response.json(
      { error: "cancel-candidate requires a non-empty candidateId." },
      { status: 400 },
    );
  }

  try {
    await requireOwnedProject(projectId, guarded.user);
    const projectRecords = await listProjectExperimentRuns({
      ownerId: guarded.user.id,
      projectId,
    });
    const experimentRecords = projectRecords.filter(
      (record) => record.experimentId === experimentId,
    );
    if (experimentRecords.length === 0) {
      return Response.json({ error: "Experiment not found." }, { status: 404 });
    }

    if (action === "cancel-candidate") {
      const record = experimentRecords.find(
        (candidate) => candidate.candidateId === candidateId,
      );
      if (!record) {
        return Response.json({ error: "Experiment candidate not found." }, { status: 404 });
      }
      if (record.status !== "running" || !record.runId) {
        return Response.json(
          { error: "Only a running candidate with a bound runtime run can be cancelled." },
          { status: 409 },
        );
      }

      await getAgentHandle(record.runtime, {
        ownerId: guarded.user.id,
        runId: record.runId,
      }).cancel();
      const cancelled = markExperimentRunCancelled(record);
      await persistExperimentRun({ ownerId: guarded.user.id, record: cancelled });

      const records = projectRecords.map((candidate) =>
        candidate.experimentId === experimentId && candidate.candidateId === candidateId
          ? cancelled
          : candidate,
      );
      return Response.json({
        cancelled: {
          experimentId: cancelled.experimentId,
          candidateId: cancelled.candidateId,
          runId: cancelled.runId,
        },
        records,
        entries: buildProjectArenaExperimentEntries(records),
      });
    }

    const promotion = buildProjectArenaPromotion(experimentRecords);
    if (!promotion.ready || !promotion.winner) {
      return Response.json(
        { error: promotion.reason, entries: buildProjectArenaExperimentEntries(experimentRecords) },
        { status: 409 },
      );
    }

    for (const record of promotion.records) {
      await persistExperimentRun({
        ownerId: guarded.user.id,
        record,
      });
    }

    const otherRecords = projectRecords.filter(
      (record) => record.experimentId !== experimentId,
    );
    const records = [...otherRecords, ...promotion.records];
    return Response.json({
      winner: {
        experimentId: promotion.winner.experimentId,
        candidateId: promotion.winner.candidateId,
        title: promotion.winner.title,
      },
      reason: promotion.reason,
      records,
      entries: buildProjectArenaExperimentEntries(records),
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return new Response(error.message, { status: error.status });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Experiment control failed." },
      { status: 500 },
    );
  }
}