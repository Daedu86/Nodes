import { NextResponse } from "next/server";
import { getAgentHandle } from "@/lib/agents/runtime/handle";
import { createJournaledAgentEventStream } from "@/lib/server/agent-stream-journal";
import { recordAgentEvent } from "@/lib/server/agent-work";
import { requireLocalApiUser } from "@/lib/server/request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const { runId: rawRunId } = await context.params;
  const runId = rawRunId?.trim();
  if (!runId) {
    return NextResponse.json({ error: "Missing run id." }, { status: 400 });
  }
  const url = new URL(req.url);
  const afterEventId = url.searchParams.get("after")?.trim() || null;

  try {
    const upstream = await getAgentHandle("codex", {
      ownerId: guarded.user.id,
      runId,
    }).openEventStream(afterEventId);
    if (!upstream.ok || !upstream.body) {
      const message = await upstream.text().catch(() => "Codex event stream unavailable.");
      return NextResponse.json(
        { error: message || "Codex event stream unavailable." },
        { status: upstream.status || 502 },
      );
    }

    await recordAgentEvent({
      actor: {
        tokenId: guarded.user.agentTokenId ?? null,
        label: guarded.user.agentLabel ?? "codex",
        ownerId: guarded.user.id,
      },
      eventType: "codex.run.stream.opened",
      method: "GET",
      route: "/api/agents/codex/runs/[runId]/events",
      payload: { runId, afterEventId },
    });

    const headers = new Headers(upstream.headers);
    headers.set("content-type", "text/event-stream; charset=utf-8");
    headers.set("cache-control", "no-cache, no-transform");
    headers.set("connection", "keep-alive");
    headers.delete("content-length");

    return new Response(
      createJournaledAgentEventStream(upstream.body, {
        ownerId: guarded.user.id,
        runtime: "codex",
        runId,
      }),
      {
        status: 200,
        headers,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Codex event stream unavailable.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
