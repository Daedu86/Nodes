import { createHash } from "node:crypto";

import { createTeamPolicyController } from "./team-policy-controller.mjs";

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const digest = (value) => createHash("sha256").update(String(value)).digest("hex");

export const AGENT_PROFILES = Object.freeze({
  generalist: {
    id: "generalist",
    role: "researcher",
    label: "Evolution Generalist",
    directive: "Produce the strongest evidence-backed variants for the selected strategy without unnecessary structural change.",
  },
  failureAnalyst: {
    id: "failure-analyst",
    role: "researcher",
    label: "Failure Analyst",
    directive: "Focus on failed and blocked evidence. Propose minimal falsifiable variants that isolate the most likely failure mechanism.",
  },
  mechanismExplorer: {
    id: "mechanism-explorer",
    role: "researcher",
    label: "Mechanism Explorer",
    directive: "Explore alternative mechanisms and structural hypotheses rather than parameter-only perturbations.",
  },
  falsifier: {
    id: "falsifier",
    role: "reviewer",
    label: "Falsification Specialist",
    directive: "Search for edge cases and disconfirming checks. Prefer variants that can expose brittle or overfit hypotheses.",
  },
  proposer: {
    id: "proposer",
    role: "researcher",
    label: "Proposal Agent",
    directive: "Draft a coherent candidate set optimized for the selected strategy. Make each hypothesis explicit and independently testable.",
  },
  critic: {
    id: "critic",
    role: "reviewer",
    label: "Critic Agent",
    directive: "Critique the proposal set in TEAM_CONTEXT and return corrected replacement variants. Attack unsupported assumptions and preserve only evidence-backed mechanisms.",
  },
  conservative: {
    id: "conservative",
    role: "reviewer",
    label: "Conservative Debater",
    directive: "Argue for low-risk incremental variants that preserve passing behavior and minimize unsupported change.",
  },
  radical: {
    id: "radical",
    role: "researcher",
    label: "Radical Debater",
    directive: "Argue for materially different mechanisms that could escape a local optimum while staying falsifiable and within the experiment objective.",
  },
  synthesizer: {
    id: "synthesizer",
    role: "planner",
    label: "Debate Synthesizer",
    directive: "Resolve the competing proposals in TEAM_CONTEXT. Return a final candidate set that captures the strongest non-duplicative hypotheses and explicitly addresses the disagreement.",
  },
});

function summarizeVariants(variants) {
  return variants.map((variant) => ({
    id: variant.id,
    experimentId: variant.spec?.experimentId ?? null,
    hypothesis: variant.metadata?.hypothesis ?? null,
    rationale: variant.metadata?.rationale ?? null,
    rewardSignalUsed: variant.metadata?.rewardSignalUsed ?? null,
  }));
}

function quotas(total, count) {
  const result = Array.from({ length: count }, () => Math.floor(total / count));
  for (let index = 0; index < total % count; index += 1) result[index] += 1;
  return result;
}

function namespaceVariant(profile, variant, index, contribution) {
  const rawId = String(variant.id || `candidate-${index + 1}`).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  return {
    ...variant,
    id: `${profile.id}-${rawId}`,
    metadata: {
      ...(isRecord(variant.metadata) ? variant.metadata : {}),
      multiAgentContribution: contribution,
    },
  };
}

export function createMultiAgentVariantGenerator(options = {}) {
  if (typeof options.baseGenerator !== "function") throw new Error("Multi-agent generator requires baseGenerator.");
  const baseGenerator = options.baseGenerator;
  const teamPolicy = options.teamPolicyController || createTeamPolicyController(options.learning || {});

  async function runAgent(input, profile, count, wave, teamContext, agentRuns) {
    if (count <= 0) return [];
    const generated = await baseGenerator({
      ...input,
      count,
      agentProfile: profile,
      teamContext,
    });
    const runId = generated.generatorRunId ?? null;
    agentRuns.push({ profileId: profile.id, role: profile.role, label: profile.label, wave, count, runId });
    return generated.variants.map((variant, index) => namespaceVariant(profile, variant, index, {
      profileId: profile.id,
      role: profile.role,
      wave,
      runId,
    }));
  }

  async function generateTopology(input, topologyId, agentRuns) {
    if (topologyId === "single") {
      return runAgent(input, AGENT_PROFILES.generalist, input.count, 1, null, agentRuns);
    }

    if (topologyId === "parallel-specialists") {
      const profiles = [AGENT_PROFILES.failureAnalyst, AGENT_PROFILES.mechanismExplorer, AGENT_PROFILES.falsifier];
      const allocation = quotas(input.count, profiles.length);
      const variants = [];
      // Deliberately serialized at the trusted Codex boundary so cancellation can
      // remain exact with the M1 single-active-generator lifecycle contract.
      for (let index = 0; index < profiles.length; index += 1) {
        variants.push(...await runAgent(input, profiles[index], allocation[index], 1, {
          topology: topologyId,
          specialistIndex: index,
          specialistCount: profiles.length,
        }, agentRuns));
      }
      return variants;
    }

    if (topologyId === "proposer-critic") {
      const proposals = await runAgent(input, AGENT_PROFILES.proposer, input.count, 1, {
        topology: topologyId,
        phase: "proposal",
      }, agentRuns);
      return runAgent(input, AGENT_PROFILES.critic, input.count, 2, {
        topology: topologyId,
        phase: "critique",
        proposals: summarizeVariants(proposals),
      }, agentRuns);
    }

    if (topologyId === "debate") {
      const conservative = await runAgent(input, AGENT_PROFILES.conservative, input.count, 1, {
        topology: topologyId,
        stance: "conservative",
      }, agentRuns);
      const radical = await runAgent(input, AGENT_PROFILES.radical, input.count, 1, {
        topology: topologyId,
        stance: "radical",
      }, agentRuns);
      return runAgent(input, AGENT_PROFILES.synthesizer, input.count, 2, {
        topology: topologyId,
        phase: "synthesis",
        conservative: summarizeVariants(conservative),
        radical: summarizeVariants(radical),
      }, agentRuns);
    }

    throw new Error(`Unsupported multi-agent topology: ${topologyId}`);
  }

  async function generate(input) {
    const selected = await teamPolicy.select({
      stateKey: input.stateKey,
      strategyActionId: input.strategyActionId,
      seedKey: input.seedKey,
    });
    const decisionId = digest(`${input.seedKey}|${selected.contextKey}|${selected.topology.id}|${selected.teamPolicyVersion}`);
    const agentRuns = [];
    const variants = await generateTopology(input, selected.topology.id, agentRuns);
    if (!Array.isArray(variants) || variants.length !== input.count) {
      throw new Error(`Multi-agent topology ${selected.topology.id} produced ${Array.isArray(variants) ? variants.length : 0} variants; expected exactly ${input.count}.`);
    }
    const ids = variants.map((variant) => variant.id);
    if (new Set(ids).size !== ids.length) throw new Error(`Multi-agent topology ${selected.topology.id} produced duplicate candidate ids.`);
    const teamMeta = {
      decisionId,
      contextKey: selected.contextKey,
      topologyId: selected.topology.id,
      topologyDescription: selected.topology.description,
      actionMode: selected.mode,
      teamPolicyVersion: selected.teamPolicyVersion,
      value: selected.value,
      epsilon: selected.epsilon,
      strategyActionId: input.strategyActionId,
      agents: agentRuns,
    };
    return {
      generatorRunId: agentRuns.at(-1)?.runId ?? `team:${decisionId}`,
      variants: variants.map((variant) => ({
        ...variant,
        metadata: {
          ...(isRecord(variant.metadata) ? variant.metadata : {}),
          multiAgentTeam: teamMeta,
        },
      })),
      team: teamMeta,
    };
  }

  return { generate, teamPolicy };
}
