import { NextResponse } from "next/server";
import {
  getCodexProjectRunnerStatus,
  type CodexRunnerNextStep,
} from "@/lib/agents/codex/runner-status";
import { requireLocalApiUser } from "@/lib/server/request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RunnerNextStep = CodexRunnerNextStep | {
  code: "configure_tycho";
  title: string;
  detail: string;
  command?: string;
};

const nextStepWithTycho = (
  status: Awaited<ReturnType<typeof getCodexProjectRunnerStatus>>,
): RunnerNextStep => {
  if (status.nextStep.code !== "ready") return status.nextStep;
  if (status.tycho.ready === true) {
    return {
      code: "ready",
      title: "Runner ready",
      detail: "Codex, exact project workspace mapping, and the Tycho isolated runtime are ready for the selected workload.",
    };
  }

  return {
    code: "configure_tycho",
    title: "Prepare the Tycho isolated runtime",
    detail:
      status.tycho.reason ??
      "Tycho must report an isolated runtime as ready before this workload can run.",
    command: "tycho-experiment --doctor",
  };
};

export async function GET(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId")?.trim() || null;

  const status = await getCodexProjectRunnerStatus({
    ownerId: guarded.user.id,
    workspaceId,
  });

  return NextResponse.json({
    authenticated: status.authenticated,
    codexRunning: status.codexRunning,
    configured: status.configured,
    hasDefaultWorkspace: status.hasDefaultWorkspace,
    model: status.model,
    nextStep: nextStepWithTycho(status),
    ok: status.ok,
    reachable: status.reachable,
    tycho: status.tycho,
    tychoReady: status.tycho.ready === true,
    tychoRuntime: status.tycho.runtime,
    tychoImage: status.tycho.image,
    tychoStatus: status.tycho.reason ?? status.tycho.decision,
    workspaceConfigured: status.workspaceConfigured,
    workspaceCount: status.workspaceCount,
  });
}
