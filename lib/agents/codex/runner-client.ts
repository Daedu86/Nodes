import type {
  CodexApprovalDecision,
  CodexRunnerStartRequest,
  CodexRunnerStartResponse,
} from "@/lib/agents/codex/types";

const normalizeBaseUrl = (value: string) => value.replace(/\/+$/, "");

const getRunnerConfig = () => {
  const rawUrl = process.env.CODEX_RUNNER_URL?.trim();
  if (!rawUrl) {
    throw new Error("CODEX_RUNNER_URL is not configured.");
  }

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(new URL(rawUrl).toString());
  } catch {
    throw new Error("CODEX_RUNNER_URL must be a valid absolute URL.");
  }

  return {
    baseUrl,
    token: process.env.CODEX_RUNNER_TOKEN?.trim() || null,
  };
};

const buildRunnerHeaders = (ownerId: string, init?: HeadersInit) => {
  const { token } = getRunnerConfig();
  const headers = new Headers(init);
  headers.set("x-nodes-owner-id", ownerId);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
};

async function runnerFetch(
  ownerId: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const { baseUrl } = getRunnerConfig();
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: buildRunnerHeaders(ownerId, init?.headers),
    cache: "no-store",
  });
}

const readRunnerError = async (response: Response) => {
  const fallback = `Codex runner request failed: ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && body.error.trim()) return body.error.trim();
    if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
  } catch {
    // Fall through to a generic message.
  }
  return fallback;
};

export type CodexRunnerReadiness = {
  ok: boolean;
  codexRunning: boolean;
  authenticated: boolean;
  model: string | null;
  workspaceCount: number;
  hasDefaultWorkspace: boolean;
};

export async function getCodexRunnerReadiness(
  ownerId: string,
): Promise<CodexRunnerReadiness> {
  const response = await runnerFetch(ownerId, "/readyz", {
    method: "GET",
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    throw new Error(await readRunnerError(response));
  }

  const body = (await response.json()) as Record<string, unknown>;
  return {
    ok: body.ok === true,
    codexRunning: body.codexRunning === true,
    authenticated: body.authenticated === true,
    model: typeof body.model === "string" && body.model.trim() ? body.model.trim() : null,
    workspaceCount:
      typeof body.workspaceCount === "number" && Number.isFinite(body.workspaceCount)
        ? Math.max(0, Math.trunc(body.workspaceCount))
        : 0,
    hasDefaultWorkspace: body.hasDefaultWorkspace === true,
  };
}

export async function startCodexRun(
  input: CodexRunnerStartRequest,
): Promise<CodexRunnerStartResponse> {
  const response = await runnerFetch(input.ownerId, "/v1/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(await readRunnerError(response));
  }

  const body = (await response.json()) as Partial<CodexRunnerStartResponse>;
  if (typeof body.runId !== "string" || !body.runId.trim()) {
    throw new Error("Codex runner returned an invalid run id.");
  }

  return {
    runId: body.runId,
    threadId: typeof body.threadId === "string" ? body.threadId : null,
    status: body.status ?? "queued",
    agentId: typeof body.agentId === "string" ? body.agentId : null,
    parentRunId: typeof body.parentRunId === "string" ? body.parentRunId : input.parentRunId ?? null,
  };
}

export async function streamCodexRunEvents(
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

export async function cancelCodexRun(ownerId: string, runId: string) {
  const response = await runnerFetch(ownerId, `/v1/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(await readRunnerError(response));
  }
  return response;
}

export async function resolveCodexApproval(
  ownerId: string,
  runId: string,
  approvalId: string,
  decision: CodexApprovalDecision,
) {
  const response = await runnerFetch(
    ownerId,
    `/v1/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
  if (!response.ok) {
    throw new Error(await readRunnerError(response));
  }
  return response;
}
