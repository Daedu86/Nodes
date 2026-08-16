import { NextResponse } from "next/server";
import { getAgentHandle } from "@/lib/agents/runtime/handle";
import type { AgentRuntimeApprovalDecision } from "@/lib/agents/runtime/types";
import { recordAgentEvent } from "@/lib/server/agent-work";
import { requireLocalApiUser } from "@/lib/server/request-guards";

export const runtime = "nodejs";

const DECISIONS = new Set<AgentRuntimeApprovalDecision>([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);

export async function POST(
  req: Request,
  context: { params: Promise<{ runId: string; approvalId: string }> },
) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const { runId: rawRunId, approvalId: rawApprovalId } = await context.params;
  const runId = rawRunId?.trim();
  const approvalId = rawApprovalId?.trim();
  const body = (await req.json().catch(() => null)) as { decision?: unknown } | null;
  const decision = typeof body?.decision === "string" ? body.decision : null;

  if (!runId || !approvalId || !decision || !DECISIONS.has(decision as AgentRuntimeApprovalDecision)) {
    return NextResponse.json({ error: "Invalid approval request." }, { status: 400 });
  }

  try {
    await getAgentHandle("codex", {
      ownerId: guarded.user.id,
      runId,
    }).resolveApproval(
      approvalId,
      decision as AgentRuntimeApprovalDecision,
    );
    await recordAgentEvent({
      actor: {
        tokenId: guarded.user.agentTokenId ?? null,
        label: guarded.user.agentLabel ?? "codex",
        ownerId: guarded.user.id,
      },
      eventType: "codex.approval.resolved",
      method: "POST",
      route: "/api/agents/codex/runs/[runId]/approvals/[approvalId]",
      payload: { approvalId, decision, runId },
    });
    return NextResponse.json({ ok: true, runId, approvalId, decision });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to resolve Codex approval.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
