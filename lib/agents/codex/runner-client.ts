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
  reachable: boolean;
  ok: boolean;
  codexRunning: boolean;
  authenticated: boolean;
  model: string | null;
  workspaceCount: number;
  workspaceIds: string[];
  workspaceIdsSupported: boolean;
  hasDefaultWorkspace: boolean;
  tychoReady: boolean;
  tychoRuntime: string | null;
  tychoImage: string | null;
  tychoStatus: string | null;
};

const asRunnerBody = async (response: Response) =>
  ((await response.json().catch(() => null)) as Record<string, unknown> | null) ?? {};

const stringArrayField = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

export async function getCodexRunnerReadiness(
  ownerId: string,
): Promise<CodexRunnerReadiness> {
  const healthResponse = await runnerFetch(ownerId, "/healthz", {
    method: "GET",
    signal: AbortSignal.timeout(5_000),
  });
  if (!healthResponse.ok) {
    throw new Error(await readRunnerError(healthResponse));
  }
  const health = await asRunnerBody(healthResponse);

  const readyResponse = await runnerFetch(ownerId, "/readyz", {
    method: "GET",
    signal: AbortSignal.timeout(25_000),
  });
  if (!readyResponse.ok) {
    throw new Error(await readRunnerError(readyResponse));
  }
  const ready = await asRunnerBody(readyResponse);

  const numberField = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  const stringField = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : null;

  return {
    reachable: true,
    ok: ready.ok === true,
    codexRunning: ready.codexRunning === true || health.codexRunning === true,
    authenticated: ready.authenticated === true,
    model: stringField(ready.model) ?? stringField(health.model),
    workspaceCount: numberField(ready.workspaceCount ?? health.workspaceCount),
    workspaceIds: stringArrayField(ready.workspaceIds),
    workspaceIdsSupported: Array.isArray(ready.workspaceIds),
    hasDefaultWorkspace:
      ready.hasDefaultWorkspace === true || health.hasDefaultWorkspace === true,
    tychoReady: ready.tychoReady === true,
    tychoRuntime: stringField(ready.tychoRuntime),
    tychoImage: stringField(ready.tychoImage),
    tychoStatus: stringField(ready.tychoStatus),
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
