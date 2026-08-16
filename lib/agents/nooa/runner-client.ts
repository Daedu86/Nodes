import { runAgentRuntimeStartPipeline } from "@/lib/agents/runtime/kernel";
import { getAgentRuntimeEventSinkUrl } from "@/lib/server/agent-runtime-event-sink-url";
import type {
  AgentRuntimeRunStatus,
  AgentRuntimeStartRequest,
  AgentRuntimeStartResponse,
} from "@/lib/agents/runtime/types";
import {
  prepareAgentRuntimeRequest,
  recordAgentRuntimeStartFailure,
  recordAgentRuntimeStartSuccess,
} from "@/lib/server/agent-runtime-request";

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");

const getRunnerConfig = () => {
  const rawUrl = process.env.NOOA_RUNNER_URL?.trim();
  if (!rawUrl) throw new Error("NOOA_RUNNER_URL is not configured.");

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(new URL(rawUrl).toString());
  } catch {
    throw new Error("NOOA_RUNNER_URL must be a valid absolute URL.");
  }

  return {
    baseUrl,
    token: process.env.NOOA_RUNNER_TOKEN?.trim() || null,
  };
};

const buildRunnerHeaders = (ownerId: string, init?: HeadersInit) => {
  const { token } = getRunnerConfig();
  const headers = new Headers(init);
  headers.set("x-nodes-owner-id", ownerId);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
};

async function runnerFetch(ownerId: string, path: string, init?: RequestInit): Promise<Response> {
  const { baseUrl } = getRunnerConfig();
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: buildRunnerHeaders(ownerId, init?.headers),
    cache: "no-store",
  });
}

const readRunnerError = async (response: Response) => {
  const fallback = `NOOA runner request failed: ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
    if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
  } catch {
    // Fall through to the response status.
  }
  return fallback;
};

const RUN_STATUSES = new Set<AgentRuntimeRunStatus>([
  "queued",
  "running",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
]);

async function startNooaRunDirect(
  input: AgentRuntimeStartRequest,
): Promise<AgentRuntimeStartResponse> {
  const response = await runnerFetch(input.ownerId, "/v1/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(await readRunnerError(response));

  const body = (await response.json()) as Partial<AgentRuntimeStartResponse>;
  if (typeof body.runId !== "string" || !body.runId.trim()) {
    throw new Error("NOOA runner returned an invalid run id.");
  }
  if (body.runtime !== "nooa") throw new Error("NOOA runner returned an invalid runtime.");
  if (typeof body.nodeId !== "string" || !body.nodeId.trim()) {
    throw new Error("NOOA runner returned an invalid Canvas node id.");
  }

  return {
    runId: body.runId,
    runtime: "nooa",
    nodeId: body.nodeId,
    status: body.status && RUN_STATUSES.has(body.status) ? body.status : "queued",
    providerRunId: typeof body.providerRunId === "string" ? body.providerRunId : null,
    threadId: typeof body.threadId === "string" ? body.threadId : null,
  };
}

export async function startNooaRun(
  input: AgentRuntimeStartRequest,
): Promise<AgentRuntimeStartResponse> {
  const prepared = await prepareAgentRuntimeRequest({
    runtime: "nooa",
    ownerId: input.ownerId,
    sessionId: input.run.sessionId,
    projectId: input.run.projectId,
    role: input.run.role,
    prompt: input.run.prompt,
    sandboxPolicyId: input.run.sandbox?.policyId ?? null,
    metadata: input.run.metadata,
  });
  const request: AgentRuntimeStartRequest = {
    ...input,
    run: {
      ...input.run,
      prompt: prepared.assembly.effectivePrompt,
      metadata: {
        ...input.run.metadata,
        nodesKernel: {
          assemblyId: prepared.assembly.header.assemblyId,
          journalId: prepared.journal.identity.journalId,
          eventSinkUrl: getAgentRuntimeEventSinkUrl(),
        },
      },
    },
  };

  try {
    const response = await runAgentRuntimeStartPipeline(
      "nooa",
      request,
      startNooaRunDirect,
    );
    await recordAgentRuntimeStartSuccess(prepared.journal, {
      runtime: "nooa",
      runId: response.runId,
      providerRunId: response.providerRunId ?? null,
    });
    return response;
  } catch (error) {
    await recordAgentRuntimeStartFailure(prepared.journal, {
      runtime: "nooa",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function streamNooaRunEvents(
  ownerId: string,
  runId: string,
  afterEventId?: string | null,
) {
  const query = afterEventId ? `?after=${encodeURIComponent(afterEventId)}` : "";
  return runnerFetch(ownerId, `/v1/runs/${encodeURIComponent(runId)}/events${query}`, {
    method: "GET",
    headers: { accept: "text/event-stream" },
  });
}

export async function cancelNooaRun(ownerId: string, runId: string) {
  const response = await runnerFetch(ownerId, `/v1/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
  if (!response.ok) throw new Error(await readRunnerError(response));
  return response;
}
