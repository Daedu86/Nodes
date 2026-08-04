import path from "node:path";

export const NOOA_RUNTIME_ID = "nooa";

export const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

const asOptionalString = (value) => asString(value) || null;

function parseJsonObject(raw, variableName) {
  if (!raw?.trim()) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${variableName} must contain valid JSON.`);
  }
  if (!isRecord(value)) throw new Error(`${variableName} must be a JSON object.`);
  return value;
}

function parseStringList(value, fieldName) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => !asString(entry))) {
    throw new Error(`${fieldName} must be an array of non-empty strings.`);
  }
  return value.map((entry) => entry.trim());
}

/**
 * Workspace paths live exclusively in the runner configuration. The HTTP
 * request only carries a stable Canvas workspace id.
 */
export function parseWorkspaceMap(raw) {
  const parsed = parseJsonObject(raw, "NOOA_WORKSPACES_JSON");
  return new Map(
    Object.entries(parsed).map(([workspaceId, value]) => {
      const id = asString(workspaceId);
      const cwd = asString(value);
      if (!id || !cwd) {
        throw new Error("NOOA_WORKSPACES_JSON values must map non-empty workspace ids to paths.");
      }
      return [id, path.resolve(cwd)];
    }),
  );
}

/**
 * Each policy id resolves to a runner-owned YAML policy and a pre-approved
 * sandbox image/provider set. The browser never receives these values.
 */
export function parseOpenShellPolicyMap(raw, defaultImage) {
  const parsed = parseJsonObject(raw, "NOOA_OPENSHELL_POLICIES_JSON");
  return new Map(
    Object.entries(parsed).map(([policyId, value]) => {
      const id = asString(policyId);
      if (!id || !isRecord(value)) {
        throw new Error("NOOA_OPENSHELL_POLICIES_JSON must map policy ids to objects.");
      }

      const policyPath = asString(value.path);
      const image = asString(value.image) || asString(defaultImage);
      if (!policyPath) {
        throw new Error(`OpenShell policy '${id}' needs a path.`);
      }
      if (!image) {
        throw new Error(`OpenShell policy '${id}' needs an image or NOOA_SANDBOX_IMAGE.`);
      }

      return [id, {
        id,
        path: path.resolve(policyPath),
        image,
        providers: parseStringList(value.providers, `OpenShell policy '${id}'.providers`),
      }];
    }),
  );
}

export function resolveWorkspace(input, workspaces, defaultCwd) {
  const workspaceId = asOptionalString(input.workspaceId);
  if (workspaceId) {
    const cwd = workspaces.get(workspaceId);
    if (!cwd) throw new Error(`Unknown NOOA workspace id: ${workspaceId}`);
    return { workspaceId, cwd };
  }
  if (defaultCwd) return { workspaceId: null, cwd: path.resolve(defaultCwd) };
  return null;
}

export function resolveOpenShellPolicy(policyId, policies) {
  const policy = policies.get(policyId);
  if (!policy) throw new Error(`Unknown OpenShell policy id: ${policyId}`);
  return policy;
}

/**
 * Re-validates the provider-neutral compiler output at the security boundary.
 * This prevents direct callers from smuggling paths, images, providers, or
 * environment variables into the local OpenShell invocation.
 */
export function normalizeNooaRun(value) {
  if (!isRecord(value)) throw new Error("Missing compiled NOOA run.");
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== 1) throw new Error("Unsupported agent runtime schema version.");

  const nodeId = asString(value.nodeId);
  const sessionId = asString(value.sessionId);
  const prompt = asString(value.prompt);
  const runtime = asString(value.runtime);
  const role = asString(value.role) || "custom";
  if (!nodeId || !sessionId || !prompt) {
    throw new Error("A NOOA run needs nodeId, sessionId, and prompt.");
  }
  if (runtime !== NOOA_RUNTIME_ID) throw new Error("This runner only accepts NOOA runs.");
  if (role !== "custom") throw new Error("The local NOOA runner currently supports the custom role only.");

  const sandbox = isRecord(value.sandbox) ? value.sandbox : null;
  const provider = sandbox && asString(sandbox.provider);
  const policyId = sandbox && asString(sandbox.policyId);
  if (provider !== "openshell" || !policyId) {
    throw new Error("A NOOA run requires an OpenShell policy binding.");
  }

  return {
    schemaVersion: 1,
    nodeId,
    runtime: NOOA_RUNTIME_ID,
    sessionId,
    prompt,
    label: asString(value.label) || "NOOA Agent",
    role,
    projectId: asOptionalString(value.projectId),
    workspaceId: asOptionalString(value.workspaceId),
    parentRunId: asOptionalString(value.parentRunId),
    sandbox: {
      provider: "openshell",
      policyId,
      profileId: asOptionalString(sandbox.profileId),
    },
  };
}

export function createSandboxName(runId) {
  const compact = runId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
  if (!compact) throw new Error("Unable to create a sandbox name for this run.");
  return `nodes-nooa-${compact}`;
}

/**
 * OpenShell separates upload source and target with a colon. Supplying a
 * relative source keeps normal Windows paths out of that delimiter on a
 * single volume, while remaining valid on Unix-like hosts.
 */
export function createUploadSpec(localPath, sandboxPath, runnerCwd) {
  const local = path.resolve(localPath);
  const relative = path.relative(runnerCwd, local) || path.basename(local);
  const source = path.isAbsolute(relative) ? local : relative;
  if (source.includes(":")) {
    throw new Error(
      `Cannot upload '${local}' because OpenShell upload paths cannot contain ':'. Place the runner and workspace on the same volume.`,
    );
  }
  return `${source}:${sandboxPath}`;
}

export function buildOpenShellCreateArgs({
  sandboxName,
  policy,
  workerPath,
  inputPath,
  workspacePath,
  runnerCwd,
  model,
  maxIterations,
}) {
  const args = [
    "sandbox",
    "create",
    "--name",
    sandboxName,
    "--from",
    policy.image,
    "--policy",
    policy.path,
    "--no-auto-providers",
    "--no-tty",
    "--no-keep",
    "--label",
    `nodes.run_id=${sandboxName}`,
    "--label",
    "nodes.runtime=nooa",
  ];

  for (const provider of policy.providers) args.push("--provider", provider);
  args.push("--upload", createUploadSpec(workerPath, "/sandbox/nooa_canvas_worker.py", runnerCwd));
  args.push("--upload", createUploadSpec(inputPath, "/sandbox/.nodes/run.json", runnerCwd));
  if (workspacePath) {
    args.push("--upload", createUploadSpec(workspacePath, "/workspace", runnerCwd));
  }

  args.push("--env", "NOOA_INPUT_PATH=/sandbox/.nodes/run.json");
  if (workspacePath) args.push("--env", "NOOA_WORKSPACE_PATH=/workspace");
  if (model) args.push("--env", `NOOA_MODEL=${model}`);
  if (maxIterations) args.push("--env", `NOOA_MAX_ITERATIONS=${maxIterations}`);

  args.push("--", "python", "-u", "/sandbox/nooa_canvas_worker.py");
  return args;
}

const eventTypeMap = {
  task: "agent.started",
  message: "agent.message.delta",
  llm_output: "agent.message.completed",
  tool_call: "tool.started",
  tool_result: "tool.completed",
  python_output: "shell.completed",
  before_agent_call: "agent.started",
  after_agent_call: "trace.recorded",
  before_turn: "trace.recorded",
  after_turn: "trace.recorded",
};

export function toRuntimeEventType(nooaEventType) {
  const normalized = asString(nooaEventType)?.toLowerCase() || "";
  return eventTypeMap[normalized] || "runtime.unknown";
}

export function parseWorkerLine(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "output", text: line };
  }
  if (!isRecord(value)) return { kind: "output", text: line };

  if (value.kind === "event" && isRecord(value.event)) {
    const eventType = asString(value.event.eventType) || "unknown";
    return {
      kind: "event",
      type: toRuntimeEventType(eventType),
      payload: { ...value.event, eventType },
    };
  }
  if (value.kind === "result" && isRecord(value.result)) {
    return { kind: "result", payload: value.result };
  }
  if (value.kind === "error" && isRecord(value.error)) {
    return { kind: "error", payload: value.error };
  }
  return { kind: "output", text: line };
}
