import { NextResponse } from "next/server";
import { normalizeProjectMap } from "@/lib/project-map";
import { getProject } from "@/lib/project-store";
import { getSession, patchSession } from "@/lib/session-store";
import { requireLocalApiUser } from "@/lib/server/request-guards";
import {
  createRecoveredTychoProtocolArtifact,
  recoverUniqueTychoProtocol,
  TYCHO_PROTOCOL_PATH,
  TychoProtocolRecoveryConflictError,
} from "@/lib/agents/codex/tycho-protocol-recovery";

export const runtime = "nodejs";
export const maxDuration = 60;

const asOptionalString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export async function POST(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const body = (await req.json().catch(() => null)) as {
    projectId?: unknown;
    sessionId?: unknown;
  } | null;
  const projectId = asOptionalString(body?.projectId);
  const sessionId = asOptionalString(body?.sessionId);
  if (!projectId || !sessionId) {
    return NextResponse.json(
      { error: "Missing projectId or sessionId." },
      { status: 400 },
    );
  }

  const project = await getProject(projectId, guarded.user.id).catch(() => null);
  if (!project) {
    return NextResponse.json({ error: "Project not found." }, { status: 404 });
  }

  const map = normalizeProjectMap(project.map);
  const workloadNode = map.nodes.find(
    (node) =>
      node.primarySessionId === sessionId || node.sessionIds.includes(sessionId),
  );
  if (!workloadNode) {
    return NextResponse.json(
      { error: "Session is not attached to a workload in this project." },
      { status: 400 },
    );
  }

  const primarySessionId = workloadNode.primarySessionId ?? sessionId;
  const primarySession = await getSession(primarySessionId, guarded.user.id).catch(() => null);
  if (!primarySession) {
    return NextResponse.json({ error: "Primary session not found." }, { status: 404 });
  }

  const existing = primarySession.artifacts.find(
    (artifact) => artifact.fileName === TYCHO_PROTOCOL_PATH && artifact.content.trim(),
  );
  if (existing) {
    return NextResponse.json({
      restored: false,
      reason: "already-present",
      primarySessionId,
      artifactId: existing.id,
    });
  }

  const candidateSessionIds = [
    primarySessionId,
    ...workloadNode.sessionIds,
  ].filter((value, index, values) => value && values.indexOf(value) === index);

  const sources = [];
  for (const candidateSessionId of candidateSessionIds) {
    const candidate = await getSession(candidateSessionId, guarded.user.id).catch(() => null);
    if (candidate) {
      sources.push({ sessionId: candidateSessionId, artifacts: candidate.artifacts });
    }
  }

  let recovery;
  try {
    recovery = recoverUniqueTychoProtocol(sources);
  } catch (error) {
    if (error instanceof TychoProtocolRecoveryConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  if (!recovery) {
    return NextResponse.json(
      {
        error:
          "No previously preserved .nodes/tycho-experiment.json artifact exists in this workload. Recovery will not synthesize a new protocol.",
      },
      { status: 404 },
    );
  }

  const artifact = createRecoveredTychoProtocolArtifact({ content: recovery.content });
  const updated = await patchSession(
    primarySessionId,
    { artifacts: [...primarySession.artifacts, artifact] },
    { expectedVersion: primarySession.version, ownerId: guarded.user.id },
  );

  return NextResponse.json({
    restored: true,
    primarySessionId,
    artifactId: artifact.id,
    sessionVersion: updated.version,
    sourceArtifactIds: recovery.sourceArtifactIds,
    sourceSessionIds: recovery.sourceSessionIds,
  });
}
