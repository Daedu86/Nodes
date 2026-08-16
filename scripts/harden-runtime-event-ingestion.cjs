const fs = require('node:fs')
const read = (file) => fs.readFileSync(file, 'utf8')
const write = (file, content) => fs.writeFileSync(file, content)
const replaceOnce = (file, before, after) => {
  const source = read(file)
  const first = source.indexOf(before)
  const last = source.lastIndexOf(before)
  if (first < 0 || first !== last) throw new Error(`Expected exactly one match in ${file}`)
  write(file, source.slice(0, first) + after + source.slice(first + before.length))
}

replaceOnce(
  'lib/agents/kernel/session-log.ts',
  '  "runtime.run": {\n    runtime: string;\n    status: AgentRuntimeJournalStatus;\n    runId: string | null;\n',
  '  "runtime.run": {\n    runtime: string;\n    status: AgentRuntimeJournalStatus;\n    runId: string | null;\n    eventIngestion?: "stream" | "callback";\n',
)

replaceOnce(
  'lib/server/agent-runtime-request.ts',
  '  metadata?: Readonly<Record<string, unknown>>;\n  sections?: readonly AgentPromptSection[];\n',
  '  metadata?: Readonly<Record<string, unknown>>;\n  eventIngestion?: "stream" | "callback";\n  sections?: readonly AgentPromptSection[];\n',
)
replaceOnce(
  'lib/server/agent-runtime-request.ts',
  '    status: "requested",\n    runId: null,\n',
  '    status: "requested",\n    runId: null,\n    eventIngestion: input.eventIngestion,\n',
)

write('lib/server/agent-runtime-event-sink-url.ts', `import type { AgentRuntimeId } from "@/lib/agents/runtime/types";

const EVENT_SINK_PATH = "/api/agents/runtime-events";

const absoluteHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

export function getAgentRuntimeEventSinkUrl(): string | null {
  const explicit = process.env.NODES_RUNTIME_EVENT_SINK_URL?.trim();
  if (explicit) return absoluteHttpUrl(explicit);

  const nextAuthUrl = process.env.NEXTAUTH_URL?.trim();
  if (nextAuthUrl) {
    const base = absoluteHttpUrl(nextAuthUrl);
    if (base) return new URL(EVENT_SINK_PATH, base).toString();
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    const base = absoluteHttpUrl("https://" + vercelUrl);
    if (base) return new URL(EVENT_SINK_PATH, base).toString();
  }

  return null;
}

const tokenForRuntime = (runtime: AgentRuntimeId) =>
  (runtime === "codex" ? process.env.CODEX_RUNNER_TOKEN : process.env.NOOA_RUNNER_TOKEN)?.trim() || null;

export function getAgentRuntimeEventSinkConfig(runtime: AgentRuntimeId) {
  const url = getAgentRuntimeEventSinkUrl();
  const enabled = Boolean(url && tokenForRuntime(runtime));
  return {
    url: enabled ? url : null,
    ingestion: enabled ? "callback" as const : "stream" as const,
  };
}
`)

replaceOnce(
  'lib/server/agent-stream-journal.ts',
  '  const journal = await findAgentSessionJournalForRun(input);\n  if (!journal) return null;\n  return {\n',
  '  const journal = await findAgentSessionJournalForRun(input);\n  if (!journal) return null;\n  const callbackOwned = journal.log.events().some(\n    (event) =>\n      event.type === "runtime.run" &&\n      event.data.runtime === input.runtime &&\n      event.data.eventIngestion === "callback",\n  );\n  if (callbackOwned) return null;\n  return {\n',
)

replaceOnce(
  'services/runtime-event-sink.mjs',
  '    const runId = asString(run?.runId) || "unknown";\n    const previous = queues.get(runId) ?? Promise.resolve(false);\n',
  '    const queueId = asString(run?.journalId) || asString(run?.runId) || "unknown";\n    const previous = queues.get(queueId) ?? Promise.resolve(false);\n',
)
replaceOnce(
  'services/runtime-event-sink.mjs',
  '    queues.set(runId, current);\n',
  '    queues.set(queueId, current);\n',
)
replaceOnce(
  'services/runtime-event-sink.mjs',
  '        if (queues.get(runId) === current) queues.delete(runId);\n',
  '        if (queues.get(queueId) === current) queues.delete(queueId);\n',
)

replaceOnce(
  'lib/agents/codex/runner-client.ts',
  'import { getAgentRuntimeEventSinkUrl } from "@/lib/server/agent-runtime-event-sink-url";\n',
  'import { getAgentRuntimeEventSinkConfig } from "@/lib/server/agent-runtime-event-sink-url";\n',
)
replaceOnce(
  'lib/agents/codex/runner-client.ts',
  '  )].sort();\n  const prepared = await prepareAgentRuntimeRequest({\n',
  '  )].sort();\n  const eventSink = getAgentRuntimeEventSinkConfig("codex");\n  const prepared = await prepareAgentRuntimeRequest({\n',
)
replaceOnce(
  'lib/agents/codex/runner-client.ts',
  '    metadata: input.metadata,\n    sections: kernelOptions.sections,\n',
  '    metadata: input.metadata,\n    eventIngestion: eventSink.ingestion,\n    sections: kernelOptions.sections,\n',
)
replaceOnce(
  'lib/agents/codex/runner-client.ts',
  '        eventSinkUrl: getAgentRuntimeEventSinkUrl(),\n',
  '        eventSinkUrl: eventSink.url,\n',
)

replaceOnce(
  'lib/agents/nooa/runner-client.ts',
  'import { getAgentRuntimeEventSinkUrl } from "@/lib/server/agent-runtime-event-sink-url";\n',
  'import { getAgentRuntimeEventSinkConfig } from "@/lib/server/agent-runtime-event-sink-url";\n',
)
replaceOnce(
  'lib/agents/nooa/runner-client.ts',
  '): Promise<AgentRuntimeStartResponse> {\n  const prepared = await prepareAgentRuntimeRequest({\n',
  '): Promise<AgentRuntimeStartResponse> {\n  const eventSink = getAgentRuntimeEventSinkConfig("nooa");\n  const prepared = await prepareAgentRuntimeRequest({\n',
)
replaceOnce(
  'lib/agents/nooa/runner-client.ts',
  '    metadata: input.run.metadata,\n  });\n',
  '    metadata: input.run.metadata,\n    eventIngestion: eventSink.ingestion,\n  });\n',
)
replaceOnce(
  'lib/agents/nooa/runner-client.ts',
  '          eventSinkUrl: getAgentRuntimeEventSinkUrl(),\n',
  '          eventSinkUrl: eventSink.url,\n',
)

replaceOnce(
  'tests/agent-stream-journal.test.ts',
  'async function seedStartedRun(repository: AgentWorkRepository, runtime: "codex" | "nooa") {\n',
  'async function seedStartedRun(\n  repository: AgentWorkRepository,\n  runtime: "codex" | "nooa",\n  eventIngestion?: "stream" | "callback",\n) {\n',
)
replaceOnce(
  'tests/agent-stream-journal.test.ts',
  '    status: "started",\n    runId: "run-1",\n',
  '    status: "started",\n    runId: "run-1",\n    eventIngestion,\n',
)
replaceOnce(
  'tests/agent-stream-journal.test.ts',
  'describe("agent stream journal projection", () => {\n',
  'describe("agent stream journal projection", () => {\n  it("keeps SSE read-only when the journal is callback-owned", async () => {\n    const repository = createMemoryRepository();\n    await seedStartedRun(repository, "nooa", "callback");\n    const projector = await createAgentStreamJournalProjector({\n      ownerId: "owner-1",\n      runtime: "nooa",\n      runId: "run-1",\n      repository,\n    });\n    expect(projector).toBeNull();\n  });\n\n',
)

replaceOnce(
  'tests/runtime-event-sink.test.js',
  '  it("retries retryable failures and stays disabled without a shared secret", async () => {\n',
  '  it("serializes parent and child deliveries that share one journal", async () => {\n    let inFlight = 0;\n    let maxInFlight = 0;\n    const fetchImpl = vi.fn(async () => {\n      inFlight += 1;\n      maxInFlight = Math.max(maxInFlight, inFlight);\n      await new Promise((resolve) => setTimeout(resolve, 5));\n      inFlight -= 1;\n      return { ok: true, status: 201 };\n    });\n    const sink = createRuntimeEventSink({\n      runtime: "codex",\n      runnerToken: "secret",\n      fetchImpl,\n      retryDelaysMs: [0],\n    });\n    const base = {\n      ownerId: "owner-1",\n      sessionId: "session-1",\n      journalId: "journal-1",\n      eventSinkUrl: "https://nodes.example/api/agents/runtime-events",\n    };\n    await Promise.all([\n      sink.enqueue({ ...base, runId: "parent" }, { id: "event-1" }),\n      sink.enqueue({ ...base, runId: "child" }, { id: "event-2" }),\n    ]);\n    expect(maxInFlight).toBe(1);\n  });\n\n  it("retries retryable failures and stays disabled without a shared secret", async () => {\n',
)
