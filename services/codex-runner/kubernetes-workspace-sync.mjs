import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

const workspaceId = process.argv[2]?.trim();
if (!workspaceId) throw new Error("Usage: npm run sync:kubernetes -- <workspaceId>");

const kubectl = process.env.KUBECTL_BIN?.trim() || "kubectl";
const context = process.env.TYCHO_KUBERNETES_CONTEXT?.trim() || null;
const namespace = process.env.TYCHO_KUBERNETES_NAMESPACE?.trim() || "nodes-evolution";
const image = process.env.TYCHO_KUBERNETES_IMAGE?.trim();
if (!image) throw new Error("TYCHO_KUBERNETES_IMAGE is required.");

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);
const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const parseJsonObject = (raw, label) => {
  const parsed = JSON.parse(raw || "{}");
  if (!isRecord(parsed)) throw new Error(`${label} must be an object.`);
  return parsed;
};

const localMap = parseJsonObject(process.env.CODEX_WORKSPACES_JSON, "CODEX_WORKSPACES_JSON");
const kubernetesMap = parseJsonObject(process.env.TYCHO_KUBERNETES_WORKSPACES_JSON, "TYCHO_KUBERNETES_WORKSPACES_JSON");
const localPath = asString(localMap[workspaceId]);
if (!localPath) throw new Error(`Workspace ${workspaceId} is not mapped in CODEX_WORKSPACES_JSON.`);
const source = path.resolve(localPath);
if (!existsSync(source) || !lstatSync(source).isDirectory()) throw new Error(`Local workspace is unavailable: ${source}`);

const rawTarget = kubernetesMap[workspaceId];
const target = typeof rawTarget === "string"
  ? { persistentVolumeClaim: rawTarget, subPath: null }
  : isRecord(rawTarget)
    ? { persistentVolumeClaim: asString(rawTarget.persistentVolumeClaim || rawTarget.pvc), subPath: asString(rawTarget.subPath) }
    : null;
if (!target?.persistentVolumeClaim) throw new Error(`Workspace ${workspaceId} has no Kubernetes PVC mapping.`);

const baseArgs = context ? ["--context", context] : [];
const run = (bin, args, { input = null, inherit = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"], env: process.env });
  let stdout = "";
  let stderr = "";
  if (!inherit) {
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
  }
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${bin} ${args.join(" ")} failed: ${stderr.trim() || stdout.trim() || `exit ${code}`}`)));
  if (!inherit) child.stdin.end(input ?? undefined);
});

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const podName = `nodes-workspace-sync-${suffix}`;
const mountPath = "/source";
const destination = target.subPath ? `${mountPath}/${target.subPath}` : mountPath;
const pod = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: podName, namespace, labels: { "app.kubernetes.io/name": "nodes-workspace-sync" } },
  spec: {
    restartPolicy: "Never",
    automountServiceAccountToken: false,
    securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } },
    containers: [{
      name: "sync",
      image,
      command: ["python", "-c", "import time; time.sleep(3600)"],
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
      volumeMounts: [{ name: "source", mountPath }, { name: "tmp", mountPath: "/tmp" }],
      resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
    }],
    volumes: [
      { name: "source", persistentVolumeClaim: { claimName: target.persistentVolumeClaim } },
      { name: "tmp", emptyDir: { sizeLimit: "128Mi" } },
    ],
  },
};

const deletePod = async () => {
  await run(kubectl, [...baseArgs, "-n", namespace, "delete", "pod", podName, "--ignore-not-found=true", "--wait=false"]).catch(() => null);
};

try {
  await run(kubectl, [...baseArgs, "create", "-f", "-"], { input: JSON.stringify(pod) });
  await run(kubectl, [...baseArgs, "-n", namespace, "wait", `pod/${podName}`, "--for=condition=Ready", "--timeout=120s"]);

  const prepare = `import pathlib, shutil\np=pathlib.Path(${JSON.stringify(destination)})\np.mkdir(parents=True, exist_ok=True)\nfor c in list(p.iterdir()):\n    shutil.rmtree(c) if c.is_dir() and not c.is_symlink() else c.unlink()\n`;
  await run(kubectl, [...baseArgs, "-n", namespace, "exec", podName, "-c", "sync", "--", "python", "-c", prepare]);

  const receiver = `import pathlib,sys,tarfile\np=pathlib.Path(${JSON.stringify(destination)}).resolve()\np.mkdir(parents=True,exist_ok=True)\nwith tarfile.open(fileobj=sys.stdin.buffer,mode='r|*') as t:\n    t.extractall(p,filter='data')\n`;
  const tar = spawn("tar", [
    "-C", source,
    "--exclude=.git", "--exclude=node_modules", "--exclude=.next", "--exclude=.venv",
    "--exclude=__pycache__", "--exclude=.pytest_cache", "--exclude=dist", "--exclude=build",
    "-cf", "-", ".",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  const receiverProcess = spawn(kubectl, [...baseArgs, "-n", namespace, "exec", "-i", podName, "-c", "sync", "--", "python", "-c", receiver], { stdio: ["pipe", "inherit", "inherit"], env: process.env });
  tar.stdout.pipe(receiverProcess.stdin);
  const [tarCode, receiverCode] = await Promise.all([
    new Promise((resolve, reject) => { tar.on("error", reject); tar.on("close", resolve); }),
    new Promise((resolve, reject) => { receiverProcess.on("error", reject); receiverProcess.on("close", resolve); }),
  ]);
  if (tarCode !== 0 || receiverCode !== 0) throw new Error(`Workspace sync stream failed (tar=${tarCode}, kubectl=${receiverCode}).`);
  console.log(`Synced ${workspaceId} -> ${namespace}/${target.persistentVolumeClaim}${target.subPath ? `/${target.subPath}` : ""}`);
} finally {
  await deletePod();
}
