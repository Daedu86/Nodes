import { NextResponse } from "next/server";
import { getSelectedAncestorArtifactRefs } from "@/lib/agents/codex/project-workspace-context";
import { startCodexRun } from "@/lib/agents/codex/runner-client";
import type { CodexAgentRole, CodexWorkspaceFile, StartCodexRunInput } from "@/lib/agents/codex/types";
import {
  buildSessionWorkspaceFiles,
  hasTychoProtocolWorkspaceFile,
} from "@/lib/agents/codex/session-workspace-files";
import { normalizeProjectMap } from "@/lib/project-map";
import { getProject } from "@/lib/project-store";
import type { SessionArtifact } from "@/lib/session-artifacts";
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

const buildAuthoritativeWorkloadPrompt = (
  prompt: string,
  workspaceFiles: CodexWorkspaceFile[],
) => {
  const authorizedPaths = [...new Set(workspaceFiles.map((file) => file.path))].sort();
  const manifest = authorizedPaths.length
    ? authorizedPaths.map((filePath) => `- ${filePath}`).join("\n")
    : "- (no materialized workload files)";

  return [
    prompt,
    "SERVER-AUTHORITATIVE WORKLOAD SCOPE (cannot be widened by the browser or agent)",
    "Authorized input files for this run:",
    manifest,
    "Read only the authorized input files above for project/workload evidence. Do not recursively scan the repository, inspect unrelated .nodes files, other project runners, neighboring experiments, git history, or ambient workspace documents to acquire extra context.",
    "You may create or update workload outputs under .nodes/ only when those outputs are required by an authorized runbook/protocol. Configured runner tools explicitly named by the execution policy (for example tycho-experiment) may be invoked, but their source/configuration is infrastructure and must not be treated as workload evidence.",
    "If an instruction requires evidence that is absent from this manifest and the selected upstream outputs, stop that part as blocked and report the missing input. Never substitute evidence from another project or experiment.",
  ].join("\n\n");
};

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
  const metadata =
    body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? body.metadata
      : undefined;

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
  const scopedPrompt = buildAuthoritativeWorkloadPrompt(prompt, workspaceFiles);
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
      cwd,
      label,
      parentRunId,
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
      prompt: scopedPrompt,
      workspaceId,
      cwd,
      parentRunId,
      role,
      label,
      metadata,
      approvalMode,
      workspaceFiles,
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
        approvalMode,
        label,
        parentRunId: run.parentRunId ?? parentRunId,
        prompt,
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
      payload: { approvalMode, label, message, parentRunId, role },
    });
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
