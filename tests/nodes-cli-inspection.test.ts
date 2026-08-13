import { describe, expect, it, vi } from "vitest";
import type { AgentWorkRepository } from "@/lib/persistence/agent-work-repository";
import type {
  ProjectRecord,
  ProjectRepository,
} from "@/lib/persistence/project-repository";
import type { SessionRepository } from "@/lib/persistence/session-repository";
import type { SessionDocument } from "@/lib/session-documents";
import { EMPTY_SESSION_THREAD_EXPORT } from "@/lib/session-documents";
import type { SessionArtifact } from "@/lib/session-artifacts";
import type { CodexProjectRunnerStatus } from "@/lib/agents/codex/runner-status";
import {
  NodesAmbiguousResourceError,
  NodesInspectionService,
  NodesInvalidResourceError,
  NodesResourceNotFoundError,
  redactSensitiveText,
} from "@/lib/nodes-cli/inspection-service";

const PROJECT_ID = "039df61e-b591-4355-9c2a-49006a54f80b";
const PRIMARY_SESSION_ID = "e66cbea1-a64b-4e46-8419-1eac16f92cfd";
const UPSTREAM_SESSION_ID = "e86d4187-upstream";
const NOW = "2026-08-13T10:00:00.000Z";

const artifact = (overrides: Partial<SessionArtifact> = {}): SessionArtifact => ({
  artifactType: "file",
  blobRef: "private/storage/path",
  byteSize: 42,
  content: "authorization=super-secret-token",
  createdAt: NOW,
  fileName: "evidence.md",
  id: "artifact-1",
  mimeType: "text/markdown",
  semanticType: "evidence",
  title: "Evidence",
  updatedAt: NOW,
  ...overrides,
});

const session = (
  id: string,
  artifacts: SessionArtifact[] = [],
  title = `Session ${id}`,
): SessionDocument => ({
  archived: false,
  artifacts,
  contextLinks: [],
  createdAt: NOW,
  id,
  messageCount: 2,
  snapshot: EMPTY_SESSION_THREAD_EXPORT,
  title,
  updatedAt: NOW,
  version: 1,
});

const project = (overrides: Partial<ProjectRecord> = {}): ProjectRecord => ({
  accessRole: "owner",
  arenaWinnerBranchKey: null,
  arenaWinnerSessionId: null,
  createdAt: NOW,
  globalContext: "",
  id: PROJECT_ID,
  map: {
    version: 1,
    nodes: [
      {
        description: "Add the reviewed readiness gate.",
        id: "upstream",
        nodeType: "workload",
        primarySessionId: UPSTREAM_SESSION_ID,
        selectedOutput: {
          artifactIds: ["upstream-artifact"],
          messageId: "message-1",
          sessionId: UPSTREAM_SESSION_ID,
          summary: "Add Tycho Isolation Readiness Gate",
          updatedAt: NOW,
        },
        sessionIds: [UPSTREAM_SESSION_ID],
        status: "complete",
        terminalResult: false,
        title: "Add Tycho Isolation Readiness Gate",
      },
      {
        description: "Run the isolated empirical workload.",
        id: "run-tycho",
        nodeType: "workload",
        primarySessionId: PRIMARY_SESSION_ID,
        selectedOutput: null,
        sessionIds: [PRIMARY_SESSION_ID],
        status: "active",
        terminalResult: false,
        title: "Run Tycho Isolated Experiment",
      },
    ],
    edges: [{
      id: "upstream=>run-tycho",
      label: "readiness gate",
      sourceNodeId: "upstream",
      targetNodeId: "run-tycho",
    }],
  },
  members: [],
  memoryIds: [],
  ownerId: "owner-1",
  sessionCount: 2,
  sessionIds: [UPSTREAM_SESSION_ID, PRIMARY_SESSION_ID],
  title: "Titanic — Iteration 18 — Tycho Acceptance",
  updatedAt: NOW,
  ...overrides,
});

const runner = (
  overrides: Partial<CodexProjectRunnerStatus> = {},
): CodexProjectRunnerStatus => ({
  authenticated: true,
  codexRunning: true,
  configured: true,
  hasDefaultWorkspace: false,
  model: "gpt-test",
  nextStep: {
    code: "ready",
    detail: "Runner ready.",
    title: "Runner ready",
  },
  ok: true,
  reachable: true,
  tycho: {
    decision: null,
    filesystemExperimentPresent: false,
    filesystemProtocolPresent: false,
    filesystemResultPresent: false,
    image: "tycho-python-sandbox:0.2",
    ready: true,
    reason: null,
    reported: true,
    runtime: "docker",
  },
  workspaceConfigured: true,
  workspaceCount: 1,
  workspaceKey: PROJECT_ID,
  ...overrides,
});

const projectSummary = (record: ProjectRecord) => ({
  accessRole: record.accessRole,
  arenaWinnerBranchKey: record.arenaWinnerBranchKey,
  arenaWinnerSessionId: record.arenaWinnerSessionId,
  createdAt: record.createdAt,
  id: record.id,
  memoryIds: record.memoryIds,
  sessionCount: record.sessionCount,
  title: record.title,
  updatedAt: record.updatedAt,
});

const harness = ({
  projectRecord = project(),
  sessions = [
    session(PRIMARY_SESSION_ID),
    session(UPSTREAM_SESSION_ID, [artifact({
      fileName: "gate.md",
      id: "upstream-artifact",
      title: "Gate",
    })]),
  ],
  runnerStatus = runner(),
}: {
  projectRecord?: ProjectRecord;
  runnerStatus?: CodexProjectRunnerStatus;
  sessions?: SessionDocument[];
} = {}) => {
  const sessionById = new Map(sessions.map((entry) => [entry.id, entry]));
  const projectRepository = {
    getProjectRecordForActor: vi.fn(async (id: string) => {
      if (id !== projectRecord.id) throw new Error("Project not found");
      return projectRecord;
    }),
    listProjectsForActor: vi.fn(async () => [projectSummary(projectRecord)]),
  } as unknown as ProjectRepository;
  const sessionRepository = {
    getSession: vi.fn(async (id: string) => {
      const value = sessionById.get(id);
      if (!value) throw new Error("Session not found");
      return value;
    }),
  } as unknown as SessionRepository;
  const agentWorkRepository = {
    listAgentEvents: vi.fn(async () => []),
  } as unknown as AgentWorkRepository;
  const runnerStatusLoader = vi.fn(async () => runnerStatus);
  const service = new NodesInspectionService({
    actor: { userEmail: "owner@example.com", userId: "owner-1" },
    agentWorkRepository,
    projectRepository,
    runnerStatusLoader,
    sessionRepository,
  });
  return { projectRepository, runnerStatusLoader, service, sessionRepository };
};

const authoritativeTychoArtifacts = () => [
  artifact({
    artifactType: "file",
    fileName: ".nodes/tycho-experiment.json",
    id: "protocol",
    mimeType: "application/json",
    title: "Tycho protocol",
  }),
  artifact({
    artifactType: "code",
    fileName: ".nodes/experiment.py",
    id: "experiment",
    mimeType: "text/x-python",
    title: "Experiment",
  }),
];

describe("Nodes CLI inspection service", () => {
  it("looks up projects through the configured project repository", async () => {
    const { projectRepository, service } = harness();
    await expect(service.inspectProject(PROJECT_ID)).resolves.toMatchObject({
      id: PROJECT_ID,
      workloadCount: 2,
    });
    expect(projectRepository.getProjectRecordForActor).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ claimLegacyOwnership: false, userId: "owner-1" }),
    );
  });

  it("returns a clear not-found error for unknown projects", async () => {
    await expect(harness().service.inspectProject("missing-project")).rejects.toThrow(
      new NodesResourceNotFoundError("Project not found: missing-project"),
    );
  });

  it("looks up workloads by id and exact title", async () => {
    const { service } = harness();
    await expect(service.inspectWorkload(PROJECT_ID, "run-tycho")).resolves.toMatchObject({
      workload: { id: "run-tycho" },
    });
    await expect(
      service.inspectWorkload(PROJECT_ID, "Run Tycho Isolated Experiment"),
    ).resolves.toMatchObject({ workload: { id: "run-tycho" } });
  });

  it("fails clearly on ambiguous exact workload titles", async () => {
    const record = project();
    record.map = {
      ...record.map!,
      nodes: record.map!.nodes.map((node) => ({ ...node, title: "Duplicate" })),
    };
    await expect(
      harness({ projectRecord: record }).service.inspectWorkload(PROJECT_ID, "Duplicate"),
    ).rejects.toBeInstanceOf(NodesAmbiguousResourceError);
  });

  it("identifies the primary session and all workload sessions", async () => {
    const record = project();
    record.map = {
      ...record.map!,
      nodes: record.map!.nodes.map((node) => node.id === "run-tycho"
        ? { ...node, sessionIds: [PRIMARY_SESSION_ID, "secondary-session"] }
        : node),
    };
    record.sessionIds = [...record.sessionIds, "secondary-session"];
    record.sessionCount = record.sessionIds.length;
    const inspection = await harness({
      projectRecord: record,
      sessions: [
        session(PRIMARY_SESSION_ID),
        session("secondary-session"),
        session(UPSTREAM_SESSION_ID),
      ],
    }).service.inspectWorkload(PROJECT_ID, "run-tycho");
    expect(inspection.primarySession?.id).toBe(PRIMARY_SESSION_ID);
    expect(inspection.sessions.map((entry) => entry.id)).toEqual([
      PRIMARY_SESSION_ID,
      "secondary-session",
    ]);
    expect(inspection.primarySession?.associations[0]?.isPrimary).toBe(true);
  });

  it("reports a missing primary session without suppressing diagnosis", async () => {
    const inspection = await harness({
      sessions: [session(UPSTREAM_SESSION_ID)],
    }).service.diagnoseProject(PROJECT_ID);
    expect(inspection.primarySession).toBeNull();
    expect(inspection.execution.blockers).toContainEqual(expect.objectContaining({
      code: "primary_session_not_found",
    }));
  });

  it("resolves only selected artifacts from direct upstream outputs", async () => {
    const inspection = await harness({
      sessions: [
        session(PRIMARY_SESSION_ID),
        session(UPSTREAM_SESSION_ID, [
          artifact({ id: "upstream-artifact", title: "Selected gate" }),
          artifact({ id: "not-selected", title: "Unselected draft" }),
        ]),
      ],
    }).service.inspectWorkload(PROJECT_ID, "run-tycho");
    expect(inspection.upstream).toHaveLength(1);
    expect(inspection.upstream[0]?.artifacts.map((entry) => entry.id)).toEqual([
      "upstream-artifact",
    ]);
  });

  it("detects authoritative Tycho protocol and experiment artifacts in the primary session", async () => {
    const diagnosis = await harness({
      sessions: [
        session(PRIMARY_SESSION_ID, authoritativeTychoArtifacts()),
        session(UPSTREAM_SESSION_ID),
      ],
    }).service.diagnoseProject(PROJECT_ID);
    expect(diagnosis.tycho.authoritativeProtocolPresent).toBe(true);
    expect(diagnosis.tycho.authoritativeExperimentPresent).toBe(true);
    expect(diagnosis.authoritativeArtifacts.every((entry) => entry.present)).toBe(true);
  });

  it("does not treat a filesystem protocol as an authoritative primary-session artifact", async () => {
    const status = runner();
    status.tycho = {
      ...status.tycho,
      filesystemExperimentPresent: true,
      filesystemProtocolPresent: true,
    };
    const diagnosis = await harness({ runnerStatus: status }).service.diagnoseProject(PROJECT_ID);
    expect(diagnosis.tycho.filesystemProtocolPresent).toBe(true);
    expect(diagnosis.tycho.authoritativeProtocolPresent).toBe(false);
    expect(diagnosis.execution.blockers).toContainEqual(expect.objectContaining({
      code: "authoritative_tycho_protocol_missing",
    }));
  });

  it("reports actual primary-session artifacts for non-Tycho workloads", async () => {
    const record = project();
    record.map = {
      ...record.map!,
      nodes: record.map!.nodes.map((node) => node.id === "run-tycho"
        ? {
            ...node,
            description: "Prepare the release notes.",
            title: "Prepare release notes",
          }
        : node),
    };
    const diagnosis = await harness({
      projectRecord: record,
      sessions: [
        session(PRIMARY_SESSION_ID, [artifact({ fileName: "release.md", id: "release" })]),
        session(UPSTREAM_SESSION_ID),
      ],
    }).service.diagnoseProject(PROJECT_ID);
    expect(diagnosis.tycho.requiredForWorkload).toBe(false);
    expect(diagnosis.authoritativeArtifacts).toEqual([
      expect.objectContaining({ artifactId: "release", path: "release.md", present: true }),
    ]);
    expect(diagnosis.execution.runnable).toBe(true);
  });

  it("reports runner ready and exact workspace mapping", async () => {
    const status = await harness().service.inspectRunner(PROJECT_ID);
    expect(status).toMatchObject({
      codexAuthenticated: true,
      online: true,
      ready: true,
      workspaceKey: PROJECT_ID,
      workspaceMapped: true,
    });
  });

  it("reports runner unavailable as a blocker", async () => {
    const status = runner({
      authenticated: false,
      codexRunning: false,
      configured: true,
      nextStep: {
        code: "start_runner",
        detail: "Runner offline.",
        title: "Start runner",
      },
      reachable: false,
      workspaceConfigured: false,
    });
    const diagnosis = await harness({ runnerStatus: status }).service.diagnoseProject(PROJECT_ID);
    expect(diagnosis.runner.online).toBe(false);
    expect(diagnosis.execution.blockers).toContainEqual(expect.objectContaining({
      code: "runner_unavailable",
    }));
  });

  it("distinguishes Tycho ready and not ready", async () => {
    const readyDiagnosis = await harness({
      sessions: [session(PRIMARY_SESSION_ID, authoritativeTychoArtifacts()), session(UPSTREAM_SESSION_ID)],
    }).service.diagnoseProject(PROJECT_ID);
    expect(readyDiagnosis.tycho.ready).toBe(true);

    const unavailable = runner();
    unavailable.tycho = { ...unavailable.tycho, ready: false, reason: "Docker unavailable." };
    const blocked = await harness({
      runnerStatus: unavailable,
      sessions: [session(PRIMARY_SESSION_ID, authoritativeTychoArtifacts()), session(UPSTREAM_SESSION_ID)],
    }).service.diagnoseProject(PROJECT_ID);
    expect(blocked.tycho.ready).toBe(false);
    expect(blocked.execution.blockers).toContainEqual(expect.objectContaining({
      code: "tycho_not_ready",
    }));
  });

  it("derives blocked and runnable execution without changing Runner UI gates", async () => {
    const blocked = await harness().service.diagnoseProject(PROJECT_ID);
    expect(blocked.execution.runnable).toBe(false);

    const runnable = await harness({
      sessions: [
        session(PRIMARY_SESSION_ID, authoritativeTychoArtifacts()),
        session(UPSTREAM_SESSION_ID),
      ],
    }).service.diagnoseProject(PROJECT_ID);
    expect(runnable.execution).toEqual({ blockers: [], runnable: true });
  });

  it("serializes stable allowlisted JSON without artifact contents, blob refs, or secrets", async () => {
    const diagnosis = await harness({
      sessions: [
        session(PRIMARY_SESSION_ID, authoritativeTychoArtifacts()),
        session(UPSTREAM_SESSION_ID, [artifact({ id: "upstream-artifact" })]),
      ],
    }).service.diagnoseProject(PROJECT_ID);
    const serialized = JSON.stringify(diagnosis);
    expect(diagnosis.schemaVersion).toBe(1);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("private/storage/path");
    expect(serialized).not.toContain('"content"');
    expect(serialized).not.toContain('"blobRef"');
  });

  it("redacts secret-looking text from summaries and runner reasons", async () => {
    const record = project();
    record.map = {
      ...record.map!,
      nodes: record.map!.nodes.map((node) => node.id === "upstream" && node.selectedOutput
        ? {
            ...node,
            selectedOutput: {
              ...node.selectedOutput,
              summary: "token=abc123 Bearer raw-secret",
            },
          }
        : node),
    };
    const diagnosis = await harness({ projectRecord: record }).service.diagnoseProject(PROJECT_ID);
    expect(JSON.stringify(diagnosis)).not.toContain("abc123");
    expect(JSON.stringify(diagnosis)).not.toContain("raw-secret");
    expect(redactSensitiveText("password=hunter2")).toBe("password=[REDACTED]");
    expect(redactSensitiveText("at /home/person/private/file.txt")).toBe(
      "at [LOCAL_PATH_REDACTED]",
    );
  });

  it("rejects unsafe project and session ids before repository access", async () => {
    const { projectRepository, service, sessionRepository } = harness();
    await expect(service.inspectProject("../secret")).rejects.toBeInstanceOf(
      NodesInvalidResourceError,
    );
    await expect(service.inspectSession("../../session")).rejects.toBeInstanceOf(
      NodesInvalidResourceError,
    );
    expect(projectRepository.getProjectRecordForActor).not.toHaveBeenCalled();
    expect(sessionRepository.getSession).not.toHaveBeenCalled();
  });
});
