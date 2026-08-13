#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const envFile = resolve(process.cwd(), ".env.local");
if (existsSync(envFile)) {
  loadEnvFile(envFile);
}

const tsxCli = fileURLToPath(import.meta.resolve("tsx/cli"));
const entrypoint = fileURLToPath(new URL("../cli/entry.ts", import.meta.url));
const tsconfig = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const child = spawn(
  process.execPath,
  [tsxCli, "--tsconfig", tsconfig, entrypoint, ...process.argv.slice(2)],
  { env: process.env, stdio: "inherit" },
);

process.exitCode = await new Promise((resolveExitCode) => {
  child.on("error", () => resolveExitCode(1));
  child.on("exit", (code, signal) => {
    if (typeof code === "number") {
      resolveExitCode(code);
      return;
    }
    resolveExitCode(signal ? 128 : 1);
  });
});
