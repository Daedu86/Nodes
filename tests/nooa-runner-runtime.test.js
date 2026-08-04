import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildOpenShellCreateArgs,
  createUploadSpec,
  normalizeNooaRun,
  parseOpenShellPolicyMap,
  parseWorkerLine,
  parseWorkspaceMap,
  resolveOpenShellPolicy,
  resolveWorkspace,
} from "../services/nooa-runner/runtime.mjs";

describe("NOOA local runner contract", () => {
  it("resolves workspace and OpenShell policy only from runner-owned maps", () => {
    const workspaces = parseWorkspaceMap('{"project-a":"/srv/repos/project-a"}');
    const policies = parseOpenShellPolicyMap(
      '{"code-safe":{"path":"/srv/policies/code-safe.yaml","image":"nodes-nooa:local","providers":["openai"]}}',
      null,
    );

    expect(resolveWorkspace({ workspaceId: "project-a" }, workspaces, null)).toEqual({
      workspaceId: "project-a",
      cwd: path.resolve("/srv/repos/project-a"),
    });
    expect(resolveOpenShellPolicy("code-safe", policies)).toMatchObject({
      id: "code-safe",
      image: "nodes-nooa:local",
      providers: ["openai"],
    });
    expect(() => resolveWorkspace({ workspaceId: "../../secret" }, workspaces, null)).toThrow(
      "Unknown NOOA workspace id",
    );
    expect(() => resolveOpenShellPolicy("anything-from-browser", policies)).toThrow(
      "Unknown OpenShell policy id",
    );
  });

  it("drops client-controlled execution details while normalizing a compiled run", () => {
    const run = normalizeNooaRun({
      schemaVersion: 1,
      runtime: "nooa",
      nodeId: "node-1",
      sessionId: "session-1",
      prompt: "Inspect the codebase",
      label: "Custom label",
      role: "custom",
      workspaceId: "project-a",
      sandbox: { provider: "openshell", policyId: "code-safe", profileId: "default" },
      metadata: {
        cwd: "/arbitrary/path",
        image: "attacker/image",
        environment: { OPENAI_API_KEY: "not-accepted" },
      },
    });

    expect(run).toEqual({
      schemaVersion: 1,
      runtime: "nooa",
      nodeId: "node-1",
      sessionId: "session-1",
      prompt: "Inspect the codebase",
      label: "Custom label",
      role: "custom",
      projectId: null,
      workspaceId: "project-a",
      parentRunId: null,
      sandbox: { provider: "openshell", policyId: "code-safe", profileId: "default" },
    });
    expect(run).not.toHaveProperty("metadata");
    expect(() => normalizeNooaRun({ ...run, sandbox: null })).toThrow("OpenShell policy binding");
  });

  it("builds a fixed OpenShell command from server-owned policy and paths", () => {
    const runnerCwd = "/srv/nodes/services/nooa-runner";
    const args = buildOpenShellCreateArgs({
      sandboxName: "nodes-nooa-123",
      policy: {
        id: "code-safe",
        path: "/srv/policies/code-safe.yaml",
        image: "nodes-nooa:local",
        providers: ["openai"],
      },
      workerPath: "/srv/nodes/services/nooa-runner/worker.py",
      inputPath: "/tmp/nodes-nooa-runner/123/run.json",
      workspacePath: "/srv/repos/project-a",
      runnerCwd,
      model: "gpt-5-mini",
      maxIterations: 12,
    });

    expect(args).toEqual(expect.arrayContaining([
      "sandbox",
      "create",
      "--from",
      "nodes-nooa:local",
      "--policy",
      "/srv/policies/code-safe.yaml",
      "--provider",
      "openai",
      "--no-auto-providers",
      "--no-keep",
      "--",
      "python",
      "-u",
      "/sandbox/nooa_canvas_worker.py",
    ]));
    expect(args.join(" ")).not.toContain("attacker/image");
    expect(args.join(" ")).not.toContain("OPENAI_API_KEY");
    expect(args).toContain(createUploadSpec("/srv/repos/project-a", "/workspace", runnerCwd));
  });

  it("normalizes NOOA worker messages into canonical runtime events", () => {
    expect(parseWorkerLine('{"kind":"event","event":{"eventType":"python_output","data":{"stdout":"ok"}}}')).toEqual({
      kind: "event",
      type: "shell.completed",
      payload: { eventType: "python_output", data: { stdout: "ok" } },
    });
    expect(parseWorkerLine('{"kind":"result","result":{"text":"Done"}}')).toEqual({
      kind: "result",
      payload: { text: "Done" },
    });
    expect(parseWorkerLine("OpenShell progress line")).toEqual({
      kind: "output",
      text: "OpenShell progress line",
    });
  });
});
