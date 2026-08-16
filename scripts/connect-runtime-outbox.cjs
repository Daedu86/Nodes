const fs = require("node:fs");

const read = (file) => fs.readFileSync(file, "utf8");
const write = (file, content) => fs.writeFileSync(file, content);
const replaceOnce = (file, before, after) => {
  const source = read(file);
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);
  if (first < 0 || first !== last) throw new Error(`Expected exactly one match in ${file}`);
  write(file, source.slice(0, first) + after + source.slice(first + before.length));
};

replaceOnce(
  "services/codex-runner/server.mjs",
  `const MANAGED_WORKSPACES_FILE = path.resolve(
  process.env.CODEX_RUNNER_MANAGED_WORKSPACES_FILE?.trim() ||
    path.join(process.cwd(), ".state", "managed-workspaces.json"),
);

const runs = new Map();`,
  `const MANAGED_WORKSPACES_FILE = path.resolve(
  process.env.CODEX_RUNNER_MANAGED_WORKSPACES_FILE?.trim() ||
    path.join(process.cwd(), ".state", "managed-workspaces.json"),
);
const RUNTIME_EVENT_OUTBOX_DIR = path.resolve(
  process.env.CODEX_RUNNER_EVENT_OUTBOX_DIR?.trim() ||
    path.join(path.dirname(MANAGED_WORKSPACES_FILE), "runtime-event-outbox"),
);

const runs = new Map();`,
);
replaceOnce(
  "services/codex-runner/server.mjs",
  `const runtimeEventSink = createRuntimeEventSink({ runtime: "codex", runnerToken: RUNNER_TOKEN });`,
  `const runtimeEventSink = createRuntimeEventSink({
  runtime: "codex",
  runnerToken: RUNNER_TOKEN,
  outboxDir: RUNTIME_EVENT_OUTBOX_DIR,
});
void runtimeEventSink.recover().then((summary) => {
  if (summary.attempted > 0) {
    console.info(
      \`[codex-runner] runtime event outbox recovery: \${summary.delivered}/\${summary.attempted} delivered\`,
    );
  }
}).catch((error) => {
  console.warn("[codex-runner] runtime event outbox recovery failed", error);
});`,
);
replaceOnce(
  "services/codex-runner/server.mjs",
  `  for (const subscriber of run.subscribers) writeSse(subscriber, envelope);
  void runtimeEventSink.enqueue(run, envelope);`,
  `  void runtimeEventSink.enqueue(run, envelope);
  for (const subscriber of run.subscribers) writeSse(subscriber, envelope);`,
);

replaceOnce(
  "services/nooa-runner/server.mjs",
  `const RUNS_DIR = path.resolve(process.env.NOOA_RUNNER_HOME || path.join(os.tmpdir(), "nodes-nooa-runner"));
const WORKER_PATH = path.resolve(process.env.NOOA_WORKER_PATH || path.join(SERVICE_DIR, "worker.py"));`,
  `const RUNS_DIR = path.resolve(process.env.NOOA_RUNNER_HOME || path.join(os.tmpdir(), "nodes-nooa-runner"));
const RUNTIME_EVENT_OUTBOX_DIR = path.resolve(
  process.env.NOOA_RUNNER_EVENT_OUTBOX_DIR?.trim() ||
    path.join(RUNS_DIR, "runtime-event-outbox"),
);
const WORKER_PATH = path.resolve(process.env.NOOA_WORKER_PATH || path.join(SERVICE_DIR, "worker.py"));`,
);
replaceOnce(
  "services/nooa-runner/server.mjs",
  `const runtimeEventSink = createRuntimeEventSink({ runtime: "nooa", runnerToken: RUNNER_TOKEN });`,
  `const runtimeEventSink = createRuntimeEventSink({
  runtime: "nooa",
  runnerToken: RUNNER_TOKEN,
  outboxDir: RUNTIME_EVENT_OUTBOX_DIR,
});
void runtimeEventSink.recover().then((summary) => {
  if (summary.attempted > 0) {
    console.info(
      \`[nooa-runner] runtime event outbox recovery: \${summary.delivered}/\${summary.attempted} delivered\`,
    );
  }
}).catch((error) => {
  console.warn("[nooa-runner] runtime event outbox recovery failed", error);
});`,
);
replaceOnce(
  "services/nooa-runner/server.mjs",
  `  for (const subscriber of run.subscribers) writeSse(subscriber, event);
  void runtimeEventSink.enqueue(run, event);`,
  `  void runtimeEventSink.enqueue(run, event);
  for (const subscriber of run.subscribers) writeSse(subscriber, event);`,
);

replaceOnce(
  ".env.example",
  `# Shared secret between Nodes and the local Codex runner.
CODEX_RUNNER_TOKEN=
`,
  `# Shared secret between Nodes and the local Codex runner.
CODEX_RUNNER_TOKEN=
# Optional durable outbox for unacknowledged runtime-event callbacks.
# Put this path on persistent storage if the runner host can be replaced.
CODEX_RUNNER_EVENT_OUTBOX_DIR=
`,
);
replaceOnce(
  ".env.example",
  `# Shared secret between Nodes and the local NOOA runner.
NOOA_RUNNER_TOKEN=
`,
  `# Shared secret between Nodes and the local NOOA runner.
NOOA_RUNNER_TOKEN=
# Optional durable outbox for unacknowledged runtime-event callbacks.
# Defaults under NOOA_RUNNER_HOME; use persistent storage for host-level durability.
NOOA_RUNNER_EVENT_OUTBOX_DIR=
`,
);
