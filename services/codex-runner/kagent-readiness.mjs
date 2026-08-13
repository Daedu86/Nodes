import { spawn } from "node:child_process";

const kubectl = process.env.KUBECTL_BIN?.trim() || "kubectl";
const context = process.env.TYCHO_KUBERNETES_CONTEXT?.trim() || null;
const namespace = process.env.TYCHO_KAGENT_NAMESPACE?.trim() || "kagent";
const observerName = process.env.TYCHO_KAGENT_OBSERVER_NAME?.trim() || "nodes-evolution-observer";

const run = (args, timeoutMs = 20_000) => new Promise((resolve) => {
  const child = spawn(kubectl, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? -1, stdout, stderr });
  });
});

export async function readKagentEvolutionReadiness() {
  const base = context ? ["--context", context] : [];
  const crd = await run([...base, "get", "crd", "agents.kagent.dev", "-o", "name"]);
  if (crd.code !== 0) {
    return {
      kagentReady: false,
      kagentCrdReady: false,
      kagentObserverReady: false,
      kagentNamespace: namespace,
      kagentObserverName: observerName,
      kagentError: crd.stderr.trim() || "agents.kagent.dev CRD is unavailable.",
    };
  }

  const observer = await run([
    ...base,
    "-n", namespace,
    "get", "agent.kagent.dev", observerName,
    "-o", "name",
  ]);
  const observerReady = observer.code === 0;
  return {
    kagentReady: observerReady,
    kagentCrdReady: true,
    kagentObserverReady: observerReady,
    kagentNamespace: namespace,
    kagentObserverName: observerName,
    kagentError: observerReady ? null : observer.stderr.trim() || `Agent ${namespace}/${observerName} is unavailable.`,
  };
}
