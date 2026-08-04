import { NextResponse } from "next/server";
import { startNooaRun } from "@/lib/agents/nooa/runner-client";
import { compileAgentNode } from "@/lib/agents/runtime/compiler";
import type { AgentRuntimeNode } from "@/lib/agents/runtime/types";
import { recordAgentEvent } from "@/lib/server/agent-work";
import { requireLocalApiUser } from "@/lib/server/request-guards";
import { getSession } from "@/lib/session-store";

export const runtime = "nodejs";
export const maxDuration = 60;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export async function POST(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const body = (await req.json().catch(() => null)) as unknown;
  if (!isRecord(body) || body.runtime !== "nooa") {
    return NextResponse.json({ error: "Expected a NOOA agent runtime node." }, { status: 400 });
  }

  const compilation = compileAgentNode(body as AgentRuntimeNode);
  if (!compilation.ok) {
    return NextResponse.json(
      { error: "NOOA agent node is invalid.", issues: compilation.issues },
      { status: 400 },
    );
  }

  const session = await getSession(compilation.run.sessionId, guarded.user.id).catch(() => null);
  if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });

  const actor = {
    tokenId: guarded.user.agentTokenId ?? null,
    label: guarded.user.agentLabel ?? "nooa",
    ownerId: guarded.user.id,
  };
  await recordAgentEvent({
    actor,
    eventType: "nooa.run.requested",
    method: "POST",
    route: "/api/agents/nooa/runs",
    sessionId: compilation.run.sessionId,
    projectId: compilation.run.projectId,
    payload: {
      nodeId: compilation.run.nodeId,
      policyId: compilation.run.sandbox?.policyId ?? null,
      role: compilation.run.role,
      workspaceId: compilation.run.workspaceId,
    },
  });

  try {
    const run = await startNooaRun({ ownerId: guarded.user.id, run: compilation.run });
    await recordAgentEvent({
      actor,
      eventType: "nooa.run.started",
      method: "POST",
      route: "/api/agents/nooa/runs",
      sessionId: compilation.run.sessionId,
      projectId: compilation.run.projectId,
      payload: {
        nodeId: run.nodeId,
        policyId: compilation.run.sandbox?.policyId ?? null,
        providerRunId: run.providerRunId ?? null,
        runId: run.runId,
        status: run.status,
      },
    });
    return NextResponse.json(run, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start NOOA run.";
    await recordAgentEvent({
      actor,
      eventType: "nooa.run.failed",
      method: "POST",
      route: "/api/agents/nooa/runs",
      sessionId: compilation.run.sessionId,
      projectId: compilation.run.projectId,
      payload: { message, nodeId: compilation.run.nodeId },
    });
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
