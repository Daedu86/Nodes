import { getAgentHandle } from "@/lib/agents/runtime/handle";
import type { AgentRuntimeId } from "@/lib/agents/runtime/types";
import {
  buildArenaExperimentPlan,
  createExperimentRunRecord,
  type ArenaExperimentChallenger,
  type ExperimentRunRecord,
} from "@/lib/agent-experiments";
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
  championRuntime?: unknown;
  championRunId?: unknown;
  challengers?: unknown;
  runId?: unknown;
  failureMessage?: unknown;
};

type ParsedChallenger = {
  challenger: ArenaExperimentChallenger;
  sandboxPolicyId: string | null;
};

export const runtime = "nodejs";

const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const runtimeId = (value: unknown): AgentRuntimeId | null =>
  value === "codex" || value === "nooa" ? value : null;

const parseChallengers = (
  value: unknown,
  projectId: string,
): ParsedChallenger[] | null => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) return null;
  const parsed: ParsedChallenger[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const id = text(record.id);
    const runtime = runtimeId(record.runtime);
    const sessionId = text(record.sessionId);
    const prompt = text(record.prompt);
    if (!id || !runtime || !sessionId || !prompt) return null;
    const sandboxPolicyId = text(record.sandboxPolicyId);
    if (runtime === "nooa" && !sandboxPolicyId) return null;
    parsed.push({
      challenger: {
        id,
        title: text(record.title),
        runtime,
        sessionId,
        projectId,
        prompt,
        model: text(record.model),
        role: runtime === "nooa" ? "custom" : text(record.role) ?? "coder",
        workspaceId: text(record.workspaceId),
        metadata:
          record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
            ? record.metadata as Record<string, unknown>
            : undefined,
      },
      sandboxPolicyId,
    });
  }
  return parsed;
};

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

const lifecycleNeedsRefresh = (record: ExperimentRunRecord) =>
  Boolean(record.runId) &&
  ["queued", "running", "waiting_for_approval"].includes(record.status);

const lifecycleChanged = (
  previous: ExperimentRunRecord,
  next: ExperimentRunRecord,
) =>
  previous.status !== next.status ||
  previous.journalId !== next.journalId ||
  previous.startedAt !== next.startedAt ||
  previous.completedAt !== next.completedAt ||
  previous.metrics.latencyMs !== next.metrics.latencyMs ||
  previous.metrics.inputTokens !== next.metrics.inputTokens ||
  previous.metrics.outputTokens !== next.metrics.outputTokens;

async function reconcileExperimentRuntimeRecords(
  ownerId: string,
  records: ExperimentRunRecord[],
) {
  return Promise.all(records.map(async (record) => {
    if (!record.runId || !lifecycleNeedsRefresh(record)) return record;
    try {
      const handle = getAgentHandle(record.runtime, { ownerId, runId: record.runId });
      const [status, metrics] = await Promise.all([handle.status(), handle.metrics()]);
      const next: ExperimentRunRecord = {
        ...record,
        status: status.status,
        journalId: status.journalId,
        startedAt:
          record.startedAt ??
          metrics.firstEventAt ??
          (status.status === "queued" ? null : status.updatedAt),
        completedAt: status.terminal ? status.updatedAt : null,
        metrics: {
          ...record.metrics,
          latencyMs: metrics.durationMs ?? record.metrics.latencyMs,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
        },
        promotionReason:
          status.status === "failed" && !record.promotionReason
            ? "Runtime journal recorded a failed candidate."
            : status.status === "cancelled" && !record.promotionReason
              ? "Runtime journal recorded a cancelled candidate."
              : record.promotionReason,
      };
      if (lifecycleChanged(record, next)) {
        await persistExperimentRun({ ownerId, record: next });
      }
      return next;
    } catch {
      // Runtime callbacks can arrive just after a start response. Keep the last
      // durable experiment snapshot and reconcile again on the next Arena poll.
      return record;
    }
  }));
}

async function loadProjectRecords(ownerId: string, projectId: string) {
  const records = await listProjectExperimentRuns({ ownerId, projectId });
  return reconcileExperimentRuntimeRecords(ownerId, records);
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
    const records = await loadProjectRecords(guarded.user.id, projectId);
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
  const action = text(body?.action) ?? "";
  const experimentId = text(body?.experimentId) ?? "";
  const candidateId = text(body?.candidateId) ?? "";

  if (
    !experimentId ||
    ![
      "plan-challengers",
      "bind-candidate",
      "fail-candidate",
      "cancel-candidate",
      "promote-best",
    ].includes(action)
  ) {
    return Response.json(
      {
        error:
          "Expected a supported experiment control action and a non-empty experimentId.",
      },
      { status: 400 },
    );
  }

  try {
    await requireOwnedProject(projectId, guarded.user);
    const projectRecords = await loadProjectRecords(guarded.user.id, projectId);

    if (action === "plan-challengers") {
      const championRuntime = runtimeId(body?.championRuntime);
      const championRunId = text(body?.championRunId);
      const parsedChallengers = parseChallengers(body?.challengers, projectId);
      if (!championRuntime || !championRunId || !parsedChallengers) {
        return Response.json(
          {
            error:
              "Planning requires championRuntime, championRunId, and 2-8 valid challengers. NOOA challengers require sandboxPolicyId.",
          },
          { status: 400 },
        );
      }
      if (projectRecords.some((record) => record.experimentId === experimentId)) {
        return Response.json(
          { error: "Experiment id already exists for this project." },
          { status: 409 },
        );
      }

      const champion = getAgentHandle(championRuntime, {
        ownerId: guarded.user.id,
        runId: championRunId,
      });
      const championStatus = await champion.status();
      if (!championStatus.terminal) {
        return Response.json(
          { error: "Arena experiments can only fork from a terminal durable parent run." },
          { status: 409 },
        );
      }
      const plan = buildArenaExperimentPlan({
        experimentId,
        champion,
        challengers: parsedChallengers.map(({ challenger }) => challenger),
      });
      for (const candidate of plan.candidates) {
        const parsed = parsedChallengers.find(
          ({ challenger }) => challenger.id === candidate.id,
        );
        if (candidate.run.runtime === "nooa" && parsed?.sandboxPolicyId) {
          candidate.run.sandbox = {
            provider: "openshell",
            policyId: parsed.sandboxPolicyId,
          };
        }
      }
      const plannedRecords = plan.candidates.map((candidate) =>
        createExperimentRunRecord({ plan, candidate }),
      );
      for (const record of plannedRecords) {
        await persistExperimentRun({ ownerId: guarded.user.id, record });
      }
      const records = [...projectRecords, ...plannedRecords];
      return Response.json(
        {
          plan,
          records,
          entries: buildProjectArenaExperimentEntries(records),
        },
        { status: 201 },
      );
    }

    const experimentRecords = projectRecords.filter(
      (record) => record.experimentId === experimentId,
    );
    if (experimentRecords.length === 0) {
      return Response.json({ error: "Experiment not found." }, { status: 404 });
    }

    if (action === "bind-candidate" || action === "fail-candidate") {
      if (!candidateId) {
        return Response.json({ error: `${action} requires candidateId.` }, { status: 400 });
      }
      const record = experimentRecords.find(
        (candidate) => candidate.candidateId === candidateId,
      );
      if (!record) {
        return Response.json({ error: "Experiment candidate not found." }, { status: 404 });
      }
      if (record.status !== "planned" && record.status !== "queued") {
        return Response.json(
          { error: `Candidate cannot transition from ${record.status} via ${action}.` },
          { status: 409 },
        );
      }

      const now = new Date().toISOString();
      const next = action === "bind-candidate"
        ? {
            ...record,
            runId: text(body?.runId),
            status: "running" as const,
            startedAt: record.startedAt ?? now,
            completedAt: null,
          }
        : {
            ...record,
            status: "failed" as const,
            completedAt: now,
            promotionReason: text(body?.failureMessage)
              ? `Launch failed: ${text(body?.failureMessage)}`
              : "Launch failed before a runtime run was bound.",
          };
      if (action === "bind-candidate" && !next.runId) {
        return Response.json(
          { error: "bind-candidate requires a non-empty runId." },
          { status: 400 },
        );
      }
      await persistExperimentRun({ ownerId: guarded.user.id, record: next });
      const records = projectRecords.map((candidate) =>
        candidate.experimentId === experimentId && candidate.candidateId === candidateId
          ? next
          : candidate,
      );
      return Response.json({
        record: next,
        records,
        entries: buildProjectArenaExperimentEntries(records),
      });
    }

    if (action === "cancel-candidate") {
      if (!candidateId) {
        return Response.json(
          { error: "cancel-candidate requires a non-empty candidateId." },
          { status: 400 },
        );
      }
      const record = experimentRecords.find(
        (candidate) => candidate.candidateId === candidateId,
      );
      if (!record) {
        return Response.json({ error: "Experiment candidate not found." }, { status: 404 });
      }
      if (
        !["queued", "running", "waiting_for_approval"].includes(record.status) ||
        !record.runId
      ) {
        return Response.json(
          { error: "Only an active candidate with a bound runtime run can be cancelled." },
          { status: 409 },
        );
      }

      await getAgentHandle(record.runtime, {
        ownerId: guarded.user.id,
        runId: record.runId,
      }).cancel();
      const cancelled = {
        ...record,
        status: "cancelled" as const,
        completedAt: new Date().toISOString(),
        promotion: record.promotion === "champion" ? record.promotion : ("undecided" as const),
        promotionReason:
          record.promotion === "champion"
            ? record.promotionReason
            : "Cancelled from the Arena experiment control plane.",
      };
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
        {
          error: promotion.reason,
          records: projectRecords,
          entries: buildProjectArenaExperimentEntries(experimentRecords),
        },
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