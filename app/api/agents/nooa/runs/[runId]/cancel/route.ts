import { NextResponse } from "next/server";
import { getAgentHandle } from "@/lib/agents/runtime/handle";
import { recordAgentEvent } from "@/lib/server/agent-work";
import { requireLocalApiUser } from "@/lib/server/request-guards";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(
  req: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const { runId: rawRunId } = await context.params;
  const runId = rawRunId?.trim();
  if (!runId) return NextResponse.json({ error: "Missing run id." }, { status: 400 });

  try {
    const payload = await getAgentHandle("nooa", {
      ownerId: guarded.user.id,
      runId,
    }).cancel();
    await recordAgentEvent({
      actor: {
        tokenId: guarded.user.agentTokenId ?? null,
        label: guarded.user.agentLabel ?? "nooa",
        ownerId: guarded.user.id,
      },
      eventType: "nooa.run.cancelled",
      method: "POST",
      route: "/api/agents/nooa/runs/[runId]/cancel",
      payload: { runId },
    });
    return NextResponse.json(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to cancel NOOA run.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
