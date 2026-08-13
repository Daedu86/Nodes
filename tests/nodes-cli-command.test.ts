import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EMPTY_SESSION_THREAD_EXPORT } from "@/lib/session-documents";

const repositoryRoot = resolve(import.meta.dirname, "..");
const nodesBin = join(repositoryRoot, "bin", "nodes.mjs");
const NOW = "2026-08-13T10:00:00.000Z";

const runNodes = (
  args: string[],
  env: Record<string, string | undefined> = {},
) =>
  spawnSync(process.execPath, [nodesBin, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

const fixtureEnvironment = async () => {
  const root = await mkdtemp(join(tmpdir(), "nodes-cli-test-"));
  const projects = join(root, "projects");
  const sessions = join(root, "sessions");
  const agentWork = join(root, "agent-work");
  await Promise.all([
    mkdir(projects, { recursive: true }),
    mkdir(sessions, { recursive: true }),
    mkdir(agentWork, { recursive: true }),
  ]);
  await writeFile(join(projects, "project-1.json"), JSON.stringify({
    arenaWinnerBranchKey: null,
    arenaWinnerSessionId: null,
    createdAt: NOW,
    globalContext: "",
    id: "project-1",
    map: {
      edges: [],
      nodes: [{
        description: "Run the isolated empirical workload.",
        id: "tycho-run",
        nodeType: "workload",
        primarySessionId: "session-1",
        selectedOutput: null,
        sessionIds: ["session-1"],
        status: "active",
        terminalResult: false,
        title: "Run Tycho Isolated Experiment",
      }],
      version: 1,
    },
    members: [],
    memoryIds: [],
    ownerId: "owner-1",
    sessionIds: ["session-1"],
    title: "CLI fixture",
    updatedAt: NOW,
  }, null, 2));
  await writeFile(join(sessions, "session-1.json"), JSON.stringify({
    archived: false,
    artifacts: [],
    contextLinks: [],
    createdAt: NOW,
    id: "session-1",
    ownerId: "owner-1",
    snapshot: EMPTY_SESSION_THREAD_EXPORT,
    title: "Primary session",
    updatedAt: NOW,
    version: 1,
  }, null, 2));
  return {
    AGENT_WORK_STORE_DIR: agentWork,
    CODEX_RUNNER_URL: "",
    NODES_AGENT_TOKEN: "",
    NODES_CLI_USER_ID: "owner-1",
    NODES_PERSISTENCE_BACKEND: "file",
    PROJECT_STORE_DIR: projects,
    SESSION_STORE_DIR: sessions,
  };
};

describe("nodes executable", () => {
  it("is executable and provides group help without authentication", async () => {
    expect((await stat(nodesBin)).mode & 0o111).not.toBe(0);
    const result = runNodes(["project", "--help"], {
      NODES_AGENT_TOKEN: "",
      NODES_CLI_USER_ID: "",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nodes project diagnose <project-id>");
    expect(result.stderr).toBe("");
  });

  it("lists projects through the file repository in JSON mode", async () => {
    const result = runNodes(["project", "list", "--json"], await fixtureEnvironment());
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      projects: [{ id: "project-1", title: "CLI fixture" }],
      schemaVersion: 1,
    });
  });

  it("prints blocked diagnosis JSON before returning exit code 5", async () => {
    const result = runNodes(
      ["project", "diagnose", "project-1", "--json"],
      await fixtureEnvironment(),
    );
    expect(result.status).toBe(5);
    const diagnosis = JSON.parse(result.stdout);
    expect(diagnosis).toMatchObject({
      project: { id: "project-1" },
      workload: { id: "tycho-run" },
      execution: { runnable: false },
      tycho: { authoritativeProtocolPresent: false },
    });
    expect(diagnosis.execution.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "runner_not_configured" }),
      expect.objectContaining({ code: "authoritative_tycho_protocol_missing" }),
    ]));
    expect(result.stderr).toBe("");
  });

  it("uses stable exit codes for missing auth and invalid ids", async () => {
    const noAuth = runNodes(["project", "list"], {
      NODES_AGENT_TOKEN: "",
      NODES_CLI_OWNER_ID: "",
      NODES_CLI_USER_ID: "",
    });
    expect(noAuth.status).toBe(3);
    expect(noAuth.stderr).toContain("Authentication context unavailable");

    const invalid = runNodes(
      ["project", "inspect", "../secret"],
      await fixtureEnvironment(),
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Invalid project id");
  });
});
