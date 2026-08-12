import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 8_000;

const trimOutput = (value) => String(value || "").slice(0, MAX_OUTPUT_CHARS).trim();

export function readTychoReadiness({
  bin = process.env.TYCHO_EXPERIMENT_BIN?.trim() || "tycho-experiment",
  timeoutMs = Number(process.env.TYCHO_DOCTOR_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let proc;
    try {
      proc = spawnImpl(bin, ["--doctor"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        shell: false,
      });
    } catch {
      finish({ tychoReady: false, tychoRuntime: null, tychoImage: null, tychoStatus: "not_installed" });
      return;
    }

    timer = setTimeout(() => {
      proc.kill?.("SIGKILL");
      finish({ tychoReady: false, tychoRuntime: null, tychoImage: null, tychoStatus: "doctor_timeout" });
    }, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);

    proc.stdout?.setEncoding?.("utf8");
    proc.stderr?.setEncoding?.("utf8");
    proc.stdout?.on?.("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += String(chunk).slice(0, MAX_OUTPUT_CHARS - stdout.length);
    });
    proc.stderr?.on?.("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += String(chunk).slice(0, MAX_OUTPUT_CHARS - stderr.length);
    });

    proc.on("error", (error) => {
      finish({
        tychoReady: false,
        tychoRuntime: null,
        tychoImage: null,
        tychoStatus: error?.code === "ENOENT" ? "not_installed" : "doctor_failed",
      });
    });

    proc.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ tychoReady: false, tychoRuntime: null, tychoImage: null, tychoStatus: "doctor_failed" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(trimOutput(stdout));
      } catch {
        finish({ tychoReady: false, tychoRuntime: null, tychoImage: null, tychoStatus: "invalid_doctor_output" });
        return;
      }
      const runtime = typeof payload?.runtime === "string" ? payload.runtime.trim().toLowerCase() : "";
      const image = typeof payload?.image === "string" && payload.image.trim() ? payload.image.trim() : null;
      const isolated = runtime === "docker" || runtime === "finch";
      if (payload?.ok !== true || !isolated) {
        finish({
          tychoReady: false,
          tychoRuntime: isolated ? runtime : null,
          tychoImage: image,
          tychoStatus: isolated ? "doctor_failed" : "unsupported_runtime",
        });
        return;
      }
      finish({ tychoReady: true, tychoRuntime: runtime, tychoImage: image, tychoStatus: "ready" });
    });
  });
}
