import { NextResponse } from "next/server";
import { getSelectedAncestorArtifactRefs } from "@/lib/agents/codex/project-workspace-context";
import { startCodexRun } from "@/lib/agents/codex/runner-client";
import type { CodexAgentRole, CodexWorkspaceFile, StartCodexRunInput } from "@/lib/agents/codex/types";
import {
  buildSessionWorkspaceFiles,
  hasTychoProtocolWorkspaceFile,
} from "@/lib/agents/codex/session-workspace-files";
import { createAuthoritativeWorkloadSection } from "@/lib/agents/kernel/request-assembly";
import { normalizeProjectMap } from "@/lib/project-map";
import { getProject } from "@/lib/project-store";
import type { SessionArtifact } from "@/lib/session-artifacts";
import { parseAgentContinuationRequest } from "@/lib/server/agent-continuity";
import { recordAgentEvent } from "@/lib/server/agent-work";
import { requireLocalApiUser } from "@/lib/server/request-guards";
import { getSession } from "@/lib/session-store";

export const runtime = "nodejs";
export const maxDuration = 60;

const ROLES = new Set<CodexAgentRole>([
  "coder",
  "reviewer",
  "researcher",
  "tester",
  "custom",
]);

const asOptionalString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const loadSelectedAncestorArtifacts = async ({
  ownerId,
  projectId,
  sessionId,
}: {
  ownerId: string;
  projectId: string | null;
  sessionId: string;
}): Promise<SessionArtifact[]> => {
  if (!projectId) return [];

  const project = await getProject(projectId, ownerId).catch(() => null);
  if (!project) return [];

  const map = normalizeProjectMap(project.map);
  const workloadNode = map.nodes.find(
    (node) => node.primarySessionId === sessionId,
  );
  if (!workloadNode) return [];

  const refs = getSelectedAncestorArtifactRefs(map, workloadNode.id);
  if (refs.length === 0) return [];

  const sessions = new Map<string, Awaited<ReturnType<typeof getSession>>>();
  const artifacts: SessionArtifact[] = [];

  for (const ref of refs) {
    let sourceSession = sessions.get(ref.sessionId) ?? null;
    if (!sourceSession) {
      const loaded = await getSession(ref.sessionId, ownerId).catch(() => null);
      if (!loaded) {
        throw new Error(
          `Selected upstream session is unavailable for workload execution: ${ref.sessionId}`,
        );
      }
      sourceSession = loaded;
      sessions.set(ref.sessionId, loaded);
    }

    const requestedIds = new Set(ref.artifactIds);
    const selected = sourceSession.artifacts.filter((artifact) => requestedIds.has(artifact.id));
    const selectedIds = new Set(selected.map((artifact) => artifact.id));
    const missingId = ref.artifactIds.find((artifactId) => !selectedIds.has(artifactId));
    if (missingId) {
      throw new Error(
        `Selected upstream artifact is missing from session ${ref.sessionId}: ${missingId}`,
      );
    }
    artifacts.push(...selected);
  }

  return artifacts;
};

export async function POST(req: Request) {
  const guarded = await requireLocalApiUser(req);
  if ("response" in guarded) return guarded.response;

  const body = (await req.json().catch(() => null)) as Partial<StartCodexRunInput> | null;
  const sessionId = asOptionalString(body?.sessionId);
  const prompt = asOptionalString(body?.prompt);
  if (!sessionId || !prompt) {
    return NextResponse.json(
      { error: "Missing sessionId or prompt." },
      { status: 400 },
    );
  }

  const role = body?.role && ROLES.has(body.role) ? body.role : "coder";
  const projectId = asOptionalString(body?.projectId);
  const workspaceId = asOptionalString(body?.workspaceId);
  const cwd = asOptionalString(body?.cwd);
  const parentRunId = asOptionalString(body?.parentRunId);
  const label = asOptionalString(body?.label);
  const model = asOptionalString(body?.model);
  const reasoningEffort = asOptionalString(body?.reasoningEffort);
  const metadata =
    body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? body.metadata
      : undefined;

  let continuation;
  try {
    continuation = parseAgentContinuationRequest(body?.continuation);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid continuation request." },
      { status: 400 },
    );
  }

  const session = await getSession(sessionId, guarded.user.id).catch(() => null);
  if (!session) {
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }

  let workspaceFiles: CodexWorkspaceFile[];
  let ancestorArtifactCount = 0;
  try {
    const ancestorArtifacts = await loadSelectedAncestorArtifacts({
      ownerId: guarded.user.id,
      projectId,
      sessionId,
    });
    ancestorArtifactCount = ancestorArtifacts.length;
    workspaceFiles = buildSessionWorkspaceFiles([
      ...session.artifacts,
      ...ancestorArtifacts,
    ]);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to prepare authoritative workload workspace artifacts.",
      },
      { status: 400 },
    );
  }
  const approvalMode = hasTychoProtocolWorkspaceFile(workspaceFiles)
    ? "tycho-isolated" as const
    : "interactive" as const;
  const workspacePaths = workspaceFiles.map((file) => file.path).sort();

  const actor = {
    tokenId: guarded.user.agentTokenId ?? null,
    label: guarded.user.agentLabel ?? "codex",
    ownerId: guarded.user.id,
  };

  await recordAgentEvent({
    actor,
    eventType: "codex.run.requested",
    method: "POST",
    route: "/api/agents/codex/runs",
    sessionId,
    projectId,
    payload: {
      ancestorArtifactCount,
      approvalMode,
      continuation,
      cwd,
      label,
      model,
      parentRunId,
      reasoningEffort,
      role,
      workspaceFileCount: workspaceFiles.length,
      workspaceId,
      workspacePaths,
    },
  });

  try {
    const run = await startCodexRun({
      ownerId: guarded.user.id,
      sessionId,
      projectId,
      prompt,
      workspaceId,
      cwd,
      parentRunId,
      continuation,
      role,
      label,
      metadata,
      model,
      reasoningEffort,
      approvalMode,
      workspaceFiles,
    }, {
      sections: [createAuthoritativeWorkloadSection(workspacePaths)],
    });

    await recordAgentEvent({
      actor,
      eventType: "codex.run.started",
      method: "POST",
      route: "/api/agents/codex/runs",
      sessionId,
      projectId,
      payload: {
        agentId: run.agentId ?? null,
        ancestorArtifactCount,
        continuation,
        approvalMode,
        label,
        model: run.model ?? model,
        parentRunId: run.parentRunId ?? parentRunId,
        prompt,
        reasoningEffort: run.reasoningEffort ?? reasoningEffort,
        role,
        runId: run.runId,
        status: run.status,
        threadId: run.threadId ?? null,
        workspaceFileCount: workspaceFiles.length,
        workspacePaths,
      },
    });

    return NextResponse.json(run, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start Codex run.";
    await recordAgentEvent({
      actor,
      eventType: "codex.run.failed",
      method: "POST",
      route: "/api/agents/codex/runs",
      sessionId,
      projectId,
      payload: {
        approvalMode,
        continuation,
        label,
        message,
        model,
        parentRunId,
        reasoningEffort,
        role,
      },
    });
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
