import { AgentKernel } from "@/lib/agents/kernel/kernel";
import { collectAgentRunMetrics } from "@/lib/agents/kernel/observability";
import {
  assertAgentPolicyAllows,
  resolveScopedAgentPolicy,
} from "@/lib/agents/kernel/policy";
import { AgentRequestAssembler } from "@/lib/agents/kernel/request-assembly";
import { AgentSessionLog } from "@/lib/agents/kernel/session-log";
import { AgentToolRegistry } from "@/lib/agents/kernel/tools";

export const AGENT_KERNEL_CAPABILITIES = {
  tools: "agent.tools",
  sessionLogFactory: "agent.session-log-factory",
  requestAssembler: "agent.request-assembler",
  policyResolver: "agent.policy-resolver",
  metricsCollector: "agent.metrics-collector",
} as const;

export const AGENT_RUNTIME_INTERCEPTORS = {
  start: "runtime.start",
} as const;

export const AGENT_RUNTIME_EVENTS = {
  starting: "runtime.starting",
  started: "runtime.started",
  failed: "runtime.start.failed",
} as const;

export type AgentSessionLogFactory = {
  create: () => AgentSessionLog;
};

export type AgentRuntimeStartEnvelope<TRequest = unknown> = {
  runtime: string;
  request: TRequest;
};

let runtimeKernel: AgentKernel | null = null;

export function createAgentRuntimeKernel() {
  const kernel = new AgentKernel();
  kernel.mount({
    id: "nodes.agent-core",
    apply(context) {
      context.provide(AGENT_KERNEL_CAPABILITIES.tools, new AgentToolRegistry());
      context.provide<AgentSessionLogFactory>(AGENT_KERNEL_CAPABILITIES.sessionLogFactory, {
        create: () => new AgentSessionLog(),
      });
      context.provide(
        AGENT_KERNEL_CAPABILITIES.requestAssembler,
        new AgentRequestAssembler(),
      );
      context.provide(AGENT_KERNEL_CAPABILITIES.policyResolver, {
        resolve: resolveScopedAgentPolicy,
        assertAllows: assertAgentPolicyAllows,
      });
      context.provide(AGENT_KERNEL_CAPABILITIES.metricsCollector, {
        collect: collectAgentRunMetrics,
      });
    },
  });
  return kernel;
}

export function getAgentRuntimeKernel() {
  runtimeKernel ??= createAgentRuntimeKernel();
  return runtimeKernel;
}

export function getAgentRequestAssembler() {
  return getAgentRuntimeKernel().get<AgentRequestAssembler>(
    AGENT_KERNEL_CAPABILITIES.requestAssembler,
  );
}

/**
 * Shared runtime-start seam. Plugins can observe or wrap a request without a
 * provider-specific import. In the absence of interceptors this is a no-op
 * around the existing runner client, preserving current behavior.
 *
 * The lifecycle events record the effective request that reaches the terminal
 * provider after every waterfall rewrite. This keeps audit/provenance aligned
 * with execution instead of accidentally recording the browser-origin request.
 */
export async function runAgentRuntimeStartPipeline<TRequest, TResponse>(
  runtime: string,
  request: TRequest,
  terminal: (request: TRequest) => Promise<TResponse>,
  kernel: AgentKernel = getAgentRuntimeKernel(),
): Promise<TResponse> {
  const envelope: AgentRuntimeStartEnvelope<TRequest> = { runtime, request };
  let effectiveRequest = request;
  await kernel.emit(AGENT_RUNTIME_EVENTS.starting, envelope);

  try {
    const response = await kernel.runWaterfall<AgentRuntimeStartEnvelope<TRequest>, TResponse>(
      AGENT_RUNTIME_INTERCEPTORS.start,
      envelope,
      (current) => {
        effectiveRequest = current.request;
        return terminal(current.request);
      },
    );
    await kernel.emit(AGENT_RUNTIME_EVENTS.started, {
      runtime,
      request: effectiveRequest,
      response,
    });
    return response;
  } catch (error) {
    await kernel.emit(AGENT_RUNTIME_EVENTS.failed, {
      runtime,
      request: effectiveRequest,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
