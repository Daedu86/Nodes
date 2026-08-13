import { NextResponse } from "next/server";

import { reconcileDurableTychoEvolution } from "@/lib/server/durable-tycho-evolution";
import { requireLocalApiUser } from "@/lib/server/request-guards";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const guarded = await requireLocalApiUser(request);
  if ("response" in guarded) return guarded.response;

  const { runId: rawRunId } = await context.params;
  const runId = rawRunId?.trim();
  const sessionId = new URL(request.url).searchParams.get("sessionId")?.trim() ?? "";
  if (!runId || !sessionId) {
    return NextResponse.json({ error: "runId and sessionId are required." }, { status: 400 });
  }

  try {
    const reconciled = await reconcileDurableTychoEvolution(
      guarded.user.id,
      sessionId,
      runId,
    );
    return NextResponse.json(reconciled);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read durable evolution status.";
    const missing = /not linked|not found|missing/i.test(message);
    return NextResponse.json({ error: message }, { status: missing ? 404 : 503 });
  }
}
