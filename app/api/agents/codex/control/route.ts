import { NextResponse } from "next/server";
import {
  controlCodexRunner,
  getCodexRunnerControlStatus,
  type CodexRunnerControlAction,
  type CodexRunnerControlStatus,
} from "@/lib/agents/codex/runner-client";
import { getCodexProjectRunnerStatus } from "@/lib/agents/codex/runner-status";
import { requireLocalApiUser } from "@/lib/server/request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ACTIONS = new Set<CodexRunnerControlAction>([
  "runtime.start",
  "runtime.stop",
  "auth.login",
  "auth.logout",
  "workspace.attach",
  "workspace.detach",
  "tycho.verify",
]);

const offlineStatus = (): CodexRunnerControlStatus => ({
  activeRunCount: 0,
  authenticated: false,
  codexRunning: false,
  controlAvailable: false,
  hasDefaultWorkspace: false,
  model: null,
  ok: false,
  reachable: false,
  tychoImage: null,
  tychoReady: false,
  tychoRuntime: null,
  tychoStatus: null,
  workspaceConfigured: false,
  workspaceCount: 0,
  workspaceManaged: false,
});

const asOptionalString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export async function GET(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const url = new URL(req.url);
  const workspaceId = asOptionalString(url.searchParams.get("workspaceId"));

  try {
    const status = await getCodexRunnerControlStatus(guarded.user.id, workspaceId);
    return NextResponse.json({ status, error: null });
  } catch {
    const legacy = await getCodexProjectRunnerStatus({
      ownerId: guarded.user.id,
      workspaceId,
    });
    const status: CodexRunnerControlStatus = {
      ...offlineStatus(),
      authenticated: legacy.authenticated,
      codexRunning: legacy.codexRunning,
      hasDefaultWorkspace: legacy.hasDefaultWorkspace,
      model: legacy.model,
      ok: legacy.ok,
      reachable: legacy.reachable,
      tychoImage: legacy.tycho.image,
      tychoReady: legacy.tycho.ready === true,
      tychoRuntime: legacy.tycho.runtime,
      tychoStatus: legacy.tycho.reason ?? legacy.tycho.decision,
      workspaceConfigured: legacy.workspaceConfigured,
      workspaceCount: legacy.workspaceCount,
    };
    return NextResponse.json({
      status,
      error: legacy.reachable
        ? "Runner controls require the current Nodes runner. Update and restart the background runner once; after that Agent Work manages it."
        : "The local runner bridge is offline. Use the Agent Work launcher to reconnect the runner and secure tunnel.",
    });
  }
}

export async function POST(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = asOptionalString(body?.action) as CodexRunnerControlAction | null;
  const workspaceId = asOptionalString(body?.workspaceId);
  if (!action || !ACTIONS.has(action)) {
    return NextResponse.json({ error: "Invalid runner control action." }, { status: 400 });
  }
  if (action.startsWith("workspace.") && !workspaceId) {
    return NextResponse.json({ error: "Select a project before changing its workspace mapping." }, { status: 400 });
  }

  try {
    const result = await controlCodexRunner(guarded.user.id, action, workspaceId);
    return NextResponse.json({ ...result, error: null });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message.includes("active Codex runs")
            ? error.message
            : "Unable to apply the runner control. Reconnect or update the local runner, then try again.",
      },
      { status: 503 },
    );
  }
}
