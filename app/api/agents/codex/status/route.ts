import { NextResponse } from "next/server";
import { getCodexProjectRunnerStatus } from "@/lib/agents/codex/runner-status";
import { requireLocalApiUser } from "@/lib/server/request-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId")?.trim() || null;

  const status = await getCodexProjectRunnerStatus({
    ownerId: guarded.user.id,
    workspaceId,
  });
  const { tycho: unusedTycho, workspaceKey: unusedWorkspaceKey, ...safeStatus } = status;
  void unusedTycho;
  void unusedWorkspaceKey;
  return NextResponse.json(safeStatus);
}
