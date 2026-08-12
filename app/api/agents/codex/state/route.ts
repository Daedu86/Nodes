import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type {
  CodexAgentRole,
  CodexCanvasEvent,
  CodexCanvasSnapshot,
  CodexPersistedRun,
  CodexRunStatus,
} from "@/lib/agents/codex/types";
import {
  getProjectForUser,
  patchProjectForUser,
} from "@/lib/project-collaboration";
import { normalizeProjectMap } from "@/lib/project-map";
import { getAgentWorkRepository } from "@/lib/persistence/repositories";
import { recordAgentEvent } from "@/lib/server/agent-work";
import { requireLocalApiUser } from "@/lib/server/request-guards";
import { getSession } from "@/lib/session-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RUNS = 50;
const MAX_EVENTS_PER_RUN = 40;
const MAX_TEXT = 50_000;

const ROLES = new Set<CodexAgentRole>(["coder", "reviewer", "researcher", "tester", "custom"]);
const STATUSES = new Set<CodexRunStatus>([
  "queued",
  "running",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
]);
const ACTIVE_STATUSES = new Set<CodexRunStatus>(["queued", "running", "waiting_for_approval"]);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asString = (value: unknown, max = MAX_TEXT) =>
  typeof value === "string" ? value.slice(0, max) : "";

const asNullableString = (value: unknown, max = 500) => {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, max);
};

const snapshotEventId = (ownerId: string, sessionId: string) => {
  const hex = createHash("sha256")
    .update(`codex-canvas-snapshot:${ownerId}:${sessionId}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const sanitizePosition = (value: unknown) => {
  const record = asRecord(value);
  const x = record?.x;
  const y = record?.y;
  return {
    x: typeof x === "number" && Number.isFinite(x) ? x : 220,
    y: typeof y === "number" && Number.isFinite(y) ? y : 180,
  };
};

const sanitizeEvents = (value: unknown): CodexCanvasEvent[] => {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_EVENTS_PER_RUN).flatMap((entry) => {
    const record = asRecord(entry);
    if (!record || typeof record.id !== "string" || typeof record.runId !== "string") return [];
    if (typeof record.type !== "string" || typeof record.createdAt !== "string") return [];
    return [
      {
        id: record.id,
        runId: record.runId,
        threadId: asNullableString(record.threadId),
        parentRunId: asNullableString(record.parentRunId),
        agentId: asNullableString(record.agentId),
        type: record.type as CodexCanvasEvent["type"],
        createdAt: record.createdAt,
        payload: asRecord(record.payload) ?? {},
      },
    ];
  });
};

const sanitizeRun = (value: unknown): CodexPersistedRun | null => {
  const record = asRecord(value);
  if (!record) return null;
  const localId = asNullableString(record.localId, 200);
  if (!localId) return null;
  const role = ROLES.has(record.role as CodexAgentRole)
    ? (record.role as CodexAgentRole)
    : "coder";
  const status = STATUSES.has(record.status as CodexRunStatus)
    ? (record.status as CodexRunStatus)
    : "queued";
  return {
    localId,
    runId: asNullableString(record.runId, 200),
    threadId: asNullableString(record.threadId, 500),
    agentId: asNullableString(record.agentId, 500),
    parentLocalId: asNullableString(record.parentLocalId, 200),
    parentRunId: asNullableString(record.parentRunId, 200),
    role,
    label: asString(record.label, 200) || "Codex Agent",
    prompt: asString(record.prompt),
    output: asString(record.output),
    status,
    events: sanitizeEvents(record.events),
    pendingApprovalId: asNullableString(record.pendingApprovalId, 200),
    error: asNullableString(record.error, 2_000),
    position: sanitizePosition(record.position),
  };
};

const sanitizeSnapshot = (value: unknown, sessionId: string): CodexCanvasSnapshot => {
  const record = asRecord(value);
  const runs = Array.isArray(record?.runs)
    ? record.runs.slice(0, MAX_RUNS).flatMap((entry) => {
        const run = sanitizeRun(entry);
        return run ? [run] : [];
      })
    : [];
  return {
    version: 1,
    sessionId,
    projectId: asNullableString(record?.projectId, 200),
    runs,
    updatedAt: new Date().toISOString(),
  };
};

const requiredEvidenceMarker = (description: string) =>
  description.match(/\bmust\s+satisfy\s+([a-z0-9._-]+)/i)?.[1]?.trim() ?? null;

const eventEvidenceText = (event: CodexCanvasEvent) => {
  if (event.type !== "file.changed") return "";
  const params = asRecord(event.payload)?.params;
  const record = asRecord(params);
  const item = asRecord(record?.item);
  return [
    asNullableString(record?.path),
    asNullableString(record?.filePath),
    asNullableString(item?.path),
    asNullableString(item?.filePath),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
};

const runMatchesWorkload = (
  run: CodexPersistedRun,
  projectId: string,
  workloadTitle: string,
) =>
  run.prompt.includes(`Project id: ${projectId}`) &&
  run.prompt.includes(`Workload: ${workloadTitle}`);

const evidenceForRun = (
  run: CodexPersistedRun,
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>,
  marker: string | null,
) => {
  const evidenceArtifacts = session.artifacts.filter((artifact) => artifact.semanticType === "evidence");
  if (!marker) {
    return {
      ok: true,
      artifactIds: evidenceArtifacts.map((artifact) => artifact.id),
    };
  }

  const normalizedMarker = marker.toLowerCase();
  const matchingArtifacts = evidenceArtifacts.filter((artifact) =>
    [artifact.title, artifact.fileName ?? "", artifact.content]
      .join("\n")
      .toLowerCase()
      .includes(normalizedMarker),
  );
  const outputMatches = run.output.toLowerCase().includes(normalizedMarker);
  const changedFileMatches = run.events.some((event) =>
    eventEvidenceText(event).toLowerCase().includes(normalizedMarker),
  );

  return {
    ok: matchingArtifacts.length > 0 || outputMatches || changedFileMatches,
    artifactIds: matchingArtifacts.map((artifact) => artifact.id),
  };
};

const reconcileProjectRunSnapshot = async ({
  snapshot,
  session,
  user,
}: {
  snapshot: CodexCanvasSnapshot;
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  user: Parameters<typeof getProjectForUser>[1];
}) => {
  const projectId = snapshot.projectId;
  if (!projectId) return { status: "skipped", reason: "no-project" } as const;

  const project = await getProjectForUser(projectId, user).catch(() => null);
  if (!project || project.accessRole !== "owner") {
    return { status: "skipped", reason: "project-unavailable" } as const;
  }

  const map = normalizeProjectMap(project.map);
  const node = map.nodes.find((entry) => entry.primarySessionId === session.id);
  if (!node) return { status: "skipped", reason: "session-not-mapped" } as const;

  const run = [...snapshot.runs]
    .reverse()
    .find((entry) => runMatchesWorkload(entry, project.id, node.title));
  if (!run) return { status: "skipped", reason: "workload-run-not-found" } as const;

  const marker = requiredEvidenceMarker(node.description);
  const evidence = evidenceForRun(run, session, marker);
  const summary = run.output.trim() || run.error?.trim() || `Managed Codex run ${run.status}.`;
  const nextNode = { ...node };

  if (ACTIVE_STATUSES.has(run.status)) {
    nextNode.status = "active";
    nextNode.selectedOutput = null;
  } else if (run.status === "completed" && evidence.ok) {
    nextNode.status = "complete";
    nextNode.selectedOutput = {
      artifactIds: evidence.artifactIds,
      messageId: null,
      sessionId: session.id,
      summary,
      updatedAt: snapshot.updatedAt,
    };
  } else {
    nextNode.status = "blocked";
    nextNode.selectedOutput = {
      artifactIds: evidence.artifactIds,
      messageId: null,
      sessionId: session.id,
      summary:
        run.status === "completed" && marker && !evidence.ok
          ? `${summary}\n\nReconciliation blocked: required evidence marker ${marker} was not found in session evidence, run output, or changed-file evidence.`
          : summary,
      updatedAt: snapshot.updatedAt,
    };
  }

  const nodes = map.nodes.map((entry) => entry.id === node.id ? nextNode : entry);
  const nextMap = normalizeProjectMap({ ...map, nodes });
  if (JSON.stringify(nextMap) === JSON.stringify(map)) {
    return { status: "unchanged", nodeId: node.id, nodeStatus: nextNode.status } as const;
  }

  await patchProjectForUser(project.id, { map: nextMap }, user);
  return { status: "updated", nodeId: node.id, nodeStatus: nextNode.status } as const;
};

export async function GET(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId")?.trim();
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId." }, { status: 400 });

  const session = await getSession(sessionId, guarded.user.id).catch(() => null);
  if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });

  const repo = getAgentWorkRepository();
  const events = await repo.listAgentEvents(guarded.user.id, {
    sessionId,
    eventType: "codex.canvas.snapshot",
    limit: 1,
  });
  const snapshot = events[0]?.payload?.snapshot;
  return NextResponse.json({
    snapshot: sanitizeSnapshot(snapshot, sessionId),
  });
}

export async function POST(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const body = (await req.json().catch(() => null)) as { snapshot?: unknown } | null;
  const rawSnapshot = asRecord(body?.snapshot);
  const sessionId = asNullableString(rawSnapshot?.sessionId, 200);
  if (!sessionId) return NextResponse.json({ error: "Missing sessionId." }, { status: 400 });

  const session = await getSession(sessionId, guarded.user.id).catch(() => null);
  if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });

  const snapshot = sanitizeSnapshot(rawSnapshot, sessionId);
  await recordAgentEvent({
    id: snapshotEventId(guarded.user.id, sessionId),
    actor: {
      tokenId: guarded.user.agentTokenId ?? null,
      label: guarded.user.agentLabel ?? "codex",
      ownerId: guarded.user.id,
    },
    eventType: "codex.canvas.snapshot",
    method: "POST",
    route: "/api/agents/codex/state",
    sessionId,
    projectId: snapshot.projectId,
    payload: { snapshot },
  });

  const reconciliation = await reconcileProjectRunSnapshot({
    snapshot,
    session,
    user: guarded.user,
  }).catch((error) => ({
    status: "error" as const,
    reason: error instanceof Error ? error.message : "Project workload reconciliation failed.",
  }));

  return NextResponse.json({
    ok: true,
    updatedAt: snapshot.updatedAt,
    reconciliation,
  });
}
