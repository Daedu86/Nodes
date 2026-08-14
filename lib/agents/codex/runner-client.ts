import type {
  CodexApprovalDecision,
  CodexModelOption,
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
  defaultModel: string | null;
  defaultReasoningEffort: string | null;
  models: CodexModelOption[];
  workspaceCount: number;
  workspaceIds: string[];
  workspaceIdsSupported: boolean;
  hasDefaultWorkspace: boolean;
  tycho: CodexRunnerTychoReadiness;
};

export type CodexRunnerTychoReadiness = {
  decision: string | null;
  filesystemExperimentPresent: boolean | null;
  filesystemProtocolPresent: boolean | null;
  filesystemResultPresent: boolean | null;
  image: string | null;
  ready: boolean | null;
  reason: string | null;
  reported: boolean;
  runtime: string | null;
};

export type CodexRunnerControlAction =
  | "runtime.start"
  | "runtime.stop"
  | "auth.login"
  | "auth.logout"
  | "workspace.attach"
  | "workspace.detach"
  | "tycho.verify";

export type CodexRunnerControlStatus = {
  activeRunCount: number;
  authenticated: boolean;
  codexRunning: boolean;
  controlAvailable: boolean;
  hasDefaultWorkspace: boolean;
  model: string | null;
  ok: boolean;
  reachable: boolean;
  tychoImage: string | null;
  tychoReady: boolean;
  tychoRuntime: string | null;
  tychoStatus: string | null;
  workspaceConfigured: boolean;
  workspaceCount: number;
  workspaceManaged: boolean;
};

export type CodexRunnerLoginPrompt = {
  loginId: string | null;
  userCode: string;
  verificationUrl: string;
};

export type CodexRunnerControlResult = {
  login: CodexRunnerLoginPrompt | null;
  status: CodexRunnerControlStatus;
};

const asRunnerBody = async (response: Response) =>
  ((await response.json().catch(() => null)) as Record<string, unknown> | null) ?? {};

const stringArrayField = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

const recordField = (value: unknown) =>
  typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;

const booleanField = (value: unknown) => value === true;

const numberField = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;

const stringField = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const controlStatusField = (value: unknown): CodexRunnerControlStatus => {
  const status = recordField(value) ?? {};
  return {
    activeRunCount: numberField(status.activeRunCount),
    authenticated: booleanField(status.authenticated),
    codexRunning: booleanField(status.codexRunning),
    controlAvailable: booleanField(status.controlAvailable),
    hasDefaultWorkspace: booleanField(status.hasDefaultWorkspace),
    model: stringField(status.model),
    ok: booleanField(status.ok),
    reachable: booleanField(status.reachable),
    tychoImage: stringField(status.tychoImage),
    tychoReady: booleanField(status.tychoReady),
    tychoRuntime: stringField(status.tychoRuntime),
    tychoStatus: stringField(status.tychoStatus),
    workspaceConfigured: booleanField(status.workspaceConfigured),
    workspaceCount: numberField(status.workspaceCount),
    workspaceManaged: booleanField(status.workspaceManaged),
  };
};

const modelOptionsField = (value: unknown): CodexModelOption[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const model = typeof record.model === "string" ? record.model.trim() : "";
    if (!model) return [];
    return [{
      model,
      displayName:
        typeof record.displayName === "string" && record.displayName.trim()
          ? record.displayName.trim()
          : model,
      supportedReasoningEfforts: stringArrayField(record.supportedReasoningEfforts),
      defaultReasoningEffort:
        typeof record.defaultReasoningEffort === "string" && record.defaultReasoningEffort.trim()
          ? record.defaultReasoningEffort.trim()
          : null,
    }];
  });
};

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
  const tycho = recordField(ready.tycho) ?? recordField(health.tycho);
  const nullableBooleanField = (value: unknown) =>
    typeof value === "boolean" ? value : null;

  return {
    reachable: true,
    ok: ready.ok === true,
    codexRunning: ready.codexRunning === true || health.codexRunning === true,
    authenticated: ready.authenticated === true,
    model: stringField(ready.model) ?? stringField(health.model),
    defaultModel:
      stringField(ready.defaultModel) ?? stringField(ready.model) ?? stringField(health.model),
    defaultReasoningEffort:
      stringField(ready.defaultReasoningEffort) ?? stringField(health.reasoningEffort),
    models: modelOptionsField(ready.models),
    workspaceCount: numberField(ready.workspaceCount ?? health.workspaceCount),
    workspaceIds: stringArrayField(ready.workspaceIds),
    workspaceIdsSupported: Array.isArray(ready.workspaceIds),
    hasDefaultWorkspace:
      ready.hasDefaultWorkspace === true || health.hasDefaultWorkspace === true,
    tycho: {
      decision: stringField(tycho?.decision),
      filesystemExperimentPresent: nullableBooleanField(
        tycho?.filesystemExperimentPresent,
      ),
      filesystemProtocolPresent: nullableBooleanField(
        tycho?.filesystemProtocolPresent,
      ),
      filesystemResultPresent: nullableBooleanField(tycho?.filesystemResultPresent),
      image: stringField(tycho?.image),
      ready: nullableBooleanField(tycho?.ready),
      reason: stringField(tycho?.reason),
      reported: tycho !== null,
      runtime: stringField(tycho?.runtime),
    },
  };
}

export async function getCodexRunnerControlStatus(
  ownerId: string,
  workspaceId: string | null,
): Promise<CodexRunnerControlStatus> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  const response = await runnerFetch(ownerId, `/v1/control/status${query}`, {
    method: "GET",
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(await readRunnerError(response));
  return controlStatusField(await asRunnerBody(response));
}

export async function controlCodexRunner(
  ownerId: string,
  action: CodexRunnerControlAction,
  workspaceId: string | null,
): Promise<CodexRunnerControlResult> {
  const response = await runnerFetch(ownerId, "/v1/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, workspaceId }),
    signal: AbortSignal.timeout(55_000),
  });
  if (!response.ok) throw new Error(await readRunnerError(response));
  const body = await asRunnerBody(response);
  const login = recordField(body.login);
  const verificationUrl = stringField(login?.verificationUrl);
  const userCode = stringField(login?.userCode);
  return {
    login:
      verificationUrl && userCode
        ? {
            loginId: stringField(login?.loginId),
            userCode,
            verificationUrl,
          }
        : null,
    status: controlStatusField(body.status),
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
    model: typeof body.model === "string" ? body.model : input.model ?? null,
    reasoningEffort:
      typeof body.reasoningEffort === "string"
        ? body.reasoningEffort
        : input.reasoningEffort ?? null,
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
