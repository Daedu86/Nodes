import { verifyAgentToken } from "@/lib/server/agent-token";
import {
  NodesAmbiguousResourceError,
  NodesInspectionService,
  NodesInvalidResourceError,
  NodesResourceNotFoundError,
  redactSensitiveText,
} from "@/lib/nodes-cli/inspection-service";
import { NODES_CLI_SCHEMA_VERSION } from "@/lib/nodes-cli/types";
import {
  formatArtifacts,
  formatProject,
  formatProjectDiagnosis,
  formatProjectList,
  formatProjectMap,
  formatRunner,
  formatSession,
  formatTycho,
  formatWorkloadInspection,
  formatWorkloadList,
} from "@/lib/nodes-cli/format";

export const NODES_EXIT_CODES = {
  success: 0,
  invalidArguments: 1,
  notFound: 2,
  configurationUnavailable: 3,
  runnerUnavailable: 4,
  blocked: 5,
} as const;

class NodesCliConfigurationError extends Error {}
class NodesCliUsageError extends Error {}

const HELP = `nodes — inspect authoritative Nodes project/session/workload state

Usage:
  nodes <group> <command> [arguments] [--json] [--debug]

Groups:
  project   list, inspect, map, diagnose
  workload  list, inspect
  session   inspect, artifacts
  runner    status
  tycho     status

Run "nodes <group> --help" for group-specific help.`;

const PROJECT_HELP = `Usage:
  nodes project list [--json]
  nodes project inspect <project-id> [--json]
  nodes project map <project-id> [--json]
  nodes project diagnose <project-id> [--json]

project diagnose prints useful output and exits 5 when execution is blocked.`;

const WORKLOAD_HELP = `Usage:
  nodes workload list <project-id> [--json]
  nodes workload inspect <project-id> <workload-id-or-exact-title> [--json]

Exact duplicate titles are rejected as ambiguous; use the workload id.`;

const SESSION_HELP = `Usage:
  nodes session inspect <session-id> [--json]
  nodes session artifacts <session-id> [--json]`;

const RUNNER_HELP = `Usage:
  nodes runner status <project-id> [--json]

Runner status is read-only and never returns runner URLs, tokens, credentials, or workspace paths.`;

const TYCHO_HELP = `Usage:
  nodes tycho status <project-id> [--json]

This command inspects readiness and provenance. It never executes an experiment.`;

const helpFor = (group: string | undefined) => {
  if (group === "project") return PROJECT_HELP;
  if (group === "workload") return WORKLOAD_HELP;
  if (group === "session") return SESSION_HELP;
  if (group === "runner") return RUNNER_HELP;
  if (group === "tycho") return TYCHO_HELP;
  return HELP;
};

const parseArgs = (argv: string[]) => {
  const json = argv.includes("--json");
  const debug = argv.includes("--debug");
  const positional = argv.filter((argument) => argument !== "--json" && argument !== "--debug");
  const unsupported = positional.find((argument) => argument.startsWith("--") && argument !== "--help");
  if (unsupported) throw new NodesCliUsageError(`Unknown option: ${unsupported}`);
  return { debug, json, positional };
};

const requireArgument = (value: string | undefined, label: string) => {
  if (!value?.trim()) throw new NodesCliUsageError(`Missing ${label}.`);
  return value.trim();
};

const assertArgumentCount = (args: string[], expected: number, usage: string) => {
  if (args.length !== expected) throw new NodesCliUsageError(`Usage: ${usage}`);
};

const resolveActor = async () => {
  const agentToken = process.env.NODES_AGENT_TOKEN?.trim();
  if (agentToken) {
    const verified = await verifyAgentToken(agentToken);
    if (!verified) {
      throw new NodesCliConfigurationError(
        "NODES_AGENT_TOKEN is invalid, expired, revoked, or unavailable in authoritative token storage.",
      );
    }
    return {
      userEmail: null,
      userId: verified.userId,
    };
  }

  const userId = (
    process.env.NODES_CLI_USER_ID ?? process.env.NODES_CLI_OWNER_ID
  )?.trim();
  if (!userId || /[\u0000-\u001f\u007f]/u.test(userId) || userId.length > 200) {
    throw new NodesCliConfigurationError(
      "Authentication context unavailable. Set NODES_AGENT_TOKEN or NODES_CLI_USER_ID.",
    );
  }
  const userEmail = process.env.NODES_CLI_USER_EMAIL?.trim() || null;
  return { userEmail, userId };
};

const print = (value: unknown, json: boolean) => {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${String(value)}\n`);
};

const isConfigurationError = (error: unknown) => {
  if (error instanceof NodesCliConfigurationError) return true;
  if (!(error instanceof Error)) return false;
  return /missing required supabase persistence env|authentication context unavailable/iu.test(
    error.message,
  );
};

export async function runNodesCli(argv = process.argv.slice(2)) {
  let debug = false;
  try {
    const parsed = parseArgs(argv);
    debug = parsed.debug;
    const [group, command, ...args] = parsed.positional;
    if (!group || group === "--help" || command === "--help") {
      print(helpFor(group === "--help" ? undefined : group), false);
      return NODES_EXIT_CODES.success;
    }

    const actor = await resolveActor();
    const service = new NodesInspectionService({ actor });

    if (group === "project" && command === "list") {
      assertArgumentCount(args, 0, "nodes project list [--json]");
      const projects = await service.listProjects();
      print(
        parsed.json ? { projects, schemaVersion: NODES_CLI_SCHEMA_VERSION } : formatProjectList(projects),
        parsed.json,
      );
      return NODES_EXIT_CODES.success;
    }
    if (group === "project" && command === "inspect") {
      assertArgumentCount(args, 1, "nodes project inspect <project-id> [--json]");
      const project = await service.inspectProject(requireArgument(args[0], "project id"));
      print(parsed.json ? { project, schemaVersion: NODES_CLI_SCHEMA_VERSION } : formatProject(project), parsed.json);
      return NODES_EXIT_CODES.success;
    }
    if (group === "project" && command === "map") {
      assertArgumentCount(args, 1, "nodes project map <project-id> [--json]");
      const map = await service.inspectProjectMap(requireArgument(args[0], "project id"));
      print(parsed.json ? map : formatProjectMap(map), parsed.json);
      return NODES_EXIT_CODES.success;
    }
    if (group === "project" && command === "diagnose") {
      assertArgumentCount(args, 1, "nodes project diagnose <project-id> [--json]");
      const diagnosis = await service.diagnoseProject(requireArgument(args[0], "project id"));
      print(parsed.json ? diagnosis : formatProjectDiagnosis(diagnosis), parsed.json);
      return diagnosis.execution.runnable
        ? NODES_EXIT_CODES.success
        : NODES_EXIT_CODES.blocked;
    }
    if (group === "workload" && command === "list") {
      assertArgumentCount(args, 1, "nodes workload list <project-id> [--json]");
      const result = await service.listWorkloads(requireArgument(args[0], "project id"));
      print(parsed.json ? result : formatWorkloadList(result.project, result.workloads), parsed.json);
      return NODES_EXIT_CODES.success;
    }
    if (group === "workload" && command === "inspect") {
      assertArgumentCount(args, 2, "nodes workload inspect <project-id> <workload-id-or-title> [--json]");
      const result = await service.inspectWorkload(
        requireArgument(args[0], "project id"),
        requireArgument(args[1], "workload id or title"),
      );
      print(parsed.json ? result : formatWorkloadInspection(result), parsed.json);
      return NODES_EXIT_CODES.success;
    }
    if (group === "session" && command === "inspect") {
      assertArgumentCount(args, 1, "nodes session inspect <session-id> [--json]");
      const session = await service.inspectSession(requireArgument(args[0], "session id"));
      print(parsed.json ? { schemaVersion: NODES_CLI_SCHEMA_VERSION, session } : formatSession(session), parsed.json);
      return NODES_EXIT_CODES.success;
    }
    if (group === "session" && command === "artifacts") {
      assertArgumentCount(args, 1, "nodes session artifacts <session-id> [--json]");
      const result = await service.inspectSessionArtifacts(requireArgument(args[0], "session id"));
      print(parsed.json ? result : formatArtifacts(result.artifacts), parsed.json);
      return NODES_EXIT_CODES.success;
    }
    if (group === "runner" && command === "status") {
      assertArgumentCount(args, 1, "nodes runner status <project-id> [--json]");
      const projectId = requireArgument(args[0], "project id");
      const runner = await service.inspectRunner(projectId);
      print(
        parsed.json
          ? { project: { id: projectId }, runner, schemaVersion: NODES_CLI_SCHEMA_VERSION }
          : formatRunner(runner),
        parsed.json,
      );
      return runner.online ? NODES_EXIT_CODES.success : NODES_EXIT_CODES.runnerUnavailable;
    }
    if (group === "tycho" && command === "status") {
      assertArgumentCount(args, 1, "nodes tycho status <project-id> [--json]");
      const result = await service.inspectTycho(requireArgument(args[0], "project id"));
      print(parsed.json ? result : [formatTycho(result.tycho), "", `Execution runnable: ${result.execution.runnable ? "yes" : "no"}`].join("\n"), parsed.json);
      if (!result.project || !result.execution) return NODES_EXIT_CODES.invalidArguments;
      if (result.execution.blockers.some((blocker) =>
        blocker.code === "runner_not_configured" || blocker.code === "runner_unavailable")) {
        return NODES_EXIT_CODES.runnerUnavailable;
      }
      return result.execution.runnable ? NODES_EXIT_CODES.success : NODES_EXIT_CODES.blocked;
    }

    throw new NodesCliUsageError(`Unknown command: ${[group, command].filter(Boolean).join(" ")}`);
  } catch (error) {
    const message = redactSensitiveText(
      error instanceof Error ? error.message : "The nodes command failed.",
    );
    process.stderr.write(`${message}\n`);
    if (debug && error instanceof Error) {
      process.stderr.write(`[debug] ${error.name}\n`);
    }
    if (error instanceof NodesResourceNotFoundError) return NODES_EXIT_CODES.notFound;
    if (error instanceof NodesInvalidResourceError || error instanceof NodesAmbiguousResourceError) {
      return NODES_EXIT_CODES.invalidArguments;
    }
    if (error instanceof NodesCliUsageError) return NODES_EXIT_CODES.invalidArguments;
    if (isConfigurationError(error)) return NODES_EXIT_CODES.configurationUnavailable;
    return NODES_EXIT_CODES.invalidArguments;
  }
}
