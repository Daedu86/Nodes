import { NextResponse } from "next/server";
import { getCodexRunnerReadiness } from "@/lib/agents/codex/runner-client";
import { requireLocalApiUser } from "@/lib/server/request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type NextStep = {
  code: "ready" | "configure_runner" | "start_runner" | "authenticate" | "configure_workspace";
  title: string;
  detail: string;
  command?: string;
};

const nextStepFor = (status: {
  codexRunning: boolean;
  authenticated: boolean;
  workspaceCount: number;
  hasDefaultWorkspace: boolean;
}): NextStep => {
  if (!status.codexRunning) {
    return {
      code: "start_runner",
      title: "Start the local Codex Runner",
      detail: "Nodes can reach the runner configuration, but the Codex app-server is not ready yet.",
    };
  }
  if (!status.authenticated) {
    return {
      code: "authenticate",
      title: "Authenticate Codex on the runner machine",
      detail: "Authentication remains local to Codex. Nodes never stores your Codex or ChatGPT credentials.",
      command: "codex login",
    };
  }
  if (!status.hasDefaultWorkspace && status.workspaceCount === 0) {
    return {
      code: "configure_workspace",
      title: "Configure an execution workspace",
      detail: "Set CODEX_DEFAULT_CWD or CODEX_WORKSPACES_JSON on the local runner, then restart it.",
    };
  }
  return {
    code: "ready",
    title: "Runner ready",
    detail: "Select a Canvas workload with an attached session, then start the run.",
  };
};

export async function GET(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  try {
    const readiness = await getCodexRunnerReadiness(guarded.user.id);
    return NextResponse.json({
      configured: true,
      ...readiness,
      nextStep: nextStepFor(readiness),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reach the Codex runner.";
    const missingConfiguration = message.includes("CODEX_RUNNER_URL");
    return NextResponse.json({
      configured: !missingConfiguration,
      reachable: false,
      ok: false,
      codexRunning: false,
      authenticated: false,
      model: null,
      workspaceCount: 0,
      hasDefaultWorkspace: false,
      nextStep: missingConfiguration
        ? {
            code: "configure_runner",
            title: "Connect Nodes to the local runner",
            detail: "Set CODEX_RUNNER_URL on the Nodes server. Keep the runner bound to a trusted/local network and use CODEX_RUNNER_TOKEN when it is not loopback-only.",
          }
        : {
            code: "start_runner",
            title: "Start or reconnect the local Codex Runner",
            detail: "Nodes could not reach the configured runner. Start it and use Check again.",
          },
    });
  }
}
