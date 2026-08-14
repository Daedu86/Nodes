import {
  getCodexRunnerReadiness,
  type CodexRunnerReadiness,
  type CodexRunnerTychoReadiness,
} from "@/lib/agents/codex/runner-client";

export type CodexRunnerNextStep = {
  code:
    | "ready"
    | "configure_runner"
    | "start_runner"
    | "update_runner"
    | "authenticate"
    | "configure_workspace";
  command?: string;
  detail: string;
  title: string;
};

export type CodexProjectRunnerStatus = {
  authenticated: boolean;
  codexRunning: boolean;
  configured: boolean;
  hasDefaultWorkspace: boolean;
  model: string | null;
  nextStep: CodexRunnerNextStep;
  ok: boolean;
  reachable: boolean;
  tycho: CodexRunnerTychoReadiness;
  workspaceConfigured: boolean;
  workspaceCount: number;
  workspaceKey: string | null;
};

export type CodexRunnerReadinessLoader = (
  ownerId: string,
) => Promise<CodexRunnerReadiness>;

export const nextStepForCodexRunner = (
  status: Pick<
    CodexRunnerReadiness,
    | "authenticated"
    | "codexRunning"
    | "hasDefaultWorkspace"
    | "workspaceCount"
    | "workspaceIdsSupported"
  >,
  workspaceId: string | null,
  workspaceConfigured: boolean,
): CodexRunnerNextStep => {
  if (!status.codexRunning) {
    return {
      code: "start_runner",
      title: "Enable the Codex runtime",
      detail: "Open Agent Work and turn on the Codex runtime switch.",
    };
  }
  if (!status.authenticated) {
    return {
      code: "authenticate",
      title: "Sign in to Codex from Agent Work",
      detail: "Agent Work creates a secure device sign-in link. Credentials remain local to Codex and never pass through Nodes.",
    };
  }
  if (workspaceId && !status.workspaceIdsSupported) {
    return {
      code: "update_runner",
      title: "Update the local Codex Runner",
      detail: "The connected runner predates exact project-workspace verification. Pull the latest Nodes-AI-Canvas on the runner machine and restart the runner, then use Check again.",
    };
  }
  if (workspaceId && !workspaceConfigured) {
    return {
      code: "configure_workspace",
      title: "Enable this project workspace",
      detail: `Open Agent Work and map this project to the runner-owned default workspace: ${workspaceId}`,
    };
  }
  if (!workspaceId && !status.hasDefaultWorkspace && status.workspaceCount === 0) {
    return {
      code: "configure_workspace",
      title: "Configure an execution workspace",
      detail: "Set CODEX_DEFAULT_CWD or CODEX_WORKSPACES_JSON on the local runner, then restart it.",
    };
  }
  return {
    code: "ready",
    title: "Runner ready",
    detail: "Select a Canvas workload with an attached session, then start the run.",
  };
};

const emptyTychoReadiness = (): CodexRunnerTychoReadiness => ({
  decision: null,
  filesystemExperimentPresent: null,
  filesystemProtocolPresent: null,
  filesystemResultPresent: null,
  image: null,
  ready: null,
  reason: null,
  reported: false,
  runtime: null,
});

export async function getCodexProjectRunnerStatus({
  ownerId,
  workspaceId,
  loadReadiness = getCodexRunnerReadiness,
}: {
  ownerId: string;
  workspaceId: string | null;
  loadReadiness?: CodexRunnerReadinessLoader;
}): Promise<CodexProjectRunnerStatus> {
  try {
    const readiness = await loadReadiness(ownerId);
    const workspaceConfigured = workspaceId
      ? readiness.workspaceIdsSupported && readiness.workspaceIds.includes(workspaceId)
      : readiness.hasDefaultWorkspace || readiness.workspaceCount > 0;

    return {
      authenticated: readiness.authenticated,
      codexRunning: readiness.codexRunning,
      configured: true,
      hasDefaultWorkspace: readiness.hasDefaultWorkspace,
      model: readiness.model,
      nextStep: nextStepForCodexRunner(readiness, workspaceId, workspaceConfigured),
      ok: readiness.ok,
      reachable: readiness.reachable,
      tycho: readiness.tycho ?? emptyTychoReadiness(),
      workspaceConfigured,
      workspaceCount: readiness.workspaceCount,
      workspaceKey: workspaceId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to reach the Codex runner.";
    const missingConfiguration = message.includes("CODEX_RUNNER_URL");
    return {
      authenticated: false,
      codexRunning: false,
      configured: !missingConfiguration,
      hasDefaultWorkspace: false,
      model: null,
      nextStep: missingConfiguration
        ? {
            code: "configure_runner",
            title: "Connect Nodes to the local runner",
            detail: "Set CODEX_RUNNER_URL on the Nodes server. Keep the runner bound to a trusted/local network and use CODEX_RUNNER_TOKEN when it is not loopback-only.",
          }
        : {
          code: "start_runner",
          title: "Reconnect the local execution bridge",
          detail: "Open Agent Work and enable the installed Runner + secure tunnel switch, then check again.",
          },
      ok: false,
      reachable: false,
      tycho: emptyTychoReadiness(),
      workspaceConfigured: false,
      workspaceCount: 0,
      workspaceKey: workspaceId,
    };
  }
}
