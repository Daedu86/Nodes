import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { materializeWorkspaceFiles, normalizeWorkspaceFiles } from "./workspace-artifacts.mjs";

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const EXCLUDED_TOP_LEVEL = new Set([
  ".git",
  ".next",
  ".venv",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "playwright-report",
  "test-results",
  "venv",
]);

const normalizeSlash = (value) => value.split(path.sep).join("/");
const safeRunId = (value) => /^[A-Za-z0-9-]+$/.test(value);

function shouldSkip(relativePath, stat, overriddenPaths) {
  const normalized = normalizeSlash(relativePath);
  const topLevel = normalized.split("/")[0];
  if (EXCLUDED_TOP_LEVEL.has(topLevel)) return true;
  if (normalized === ".nodes/tycho-result.json") return true;
  if (overriddenPaths.has(normalized)) return true;
  if (stat.isSymbolicLink()) return true;
  return false;
}

export function createEvolutionWorkspace(sourceCwd, runId, workspaceFiles, options = {}) {
  if (!safeRunId(runId)) throw new Error("Evolution run id contains unsupported characters.");

  const source = path.resolve(sourceCwd);
  if (!existsSync(source) || !lstatSync(source).isDirectory()) {
    throw new Error("Configured evolution source workspace is unavailable.");
  }

  const files = normalizeWorkspaceFiles(workspaceFiles);
  const overriddenPaths = new Set(files.map((file) => file.path));
  if (!overriddenPaths.has(".nodes/tycho-experiment.json")) {
    throw new Error("Evolution runs require .nodes/tycho-experiment.json in workspaceFiles.");
  }

  const tempRoot = path.resolve(
    options.tempRoot || process.env.TYCHO_EVOLUTION_TEMP_ROOT || path.join(os.tmpdir(), "nodes-tycho-evolution"),
  );
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(tempRoot, runId);
  if (existsSync(destination)) throw new Error("Evolution run workspace already exists.");
  mkdirSync(destination, { recursive: false, mode: 0o700 });

  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let copiedFiles = 0;
  let copiedBytes = 0;

  const copyDirectory = (currentSource, currentDestination, relativeBase = "") => {
    for (const entry of readdirSync(currentSource, { withFileTypes: true })) {
      const sourcePath = path.join(currentSource, entry.name);
      const relativePath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
      const stat = lstatSync(sourcePath);
      if (shouldSkip(relativePath, stat, overriddenPaths)) continue;

      const destinationPath = path.join(currentDestination, entry.name);
      if (stat.isDirectory()) {
        mkdirSync(destinationPath, { recursive: false, mode: 0o700 });
        copyDirectory(sourcePath, destinationPath, relativePath);
        continue;
      }
      if (!stat.isFile()) continue;

      copiedFiles += 1;
      copiedBytes += stat.size;
      if (copiedFiles > maxFiles) throw new Error("Evolution workspace exceeds the runner file-count budget.");
      if (copiedBytes > maxBytes) throw new Error("Evolution workspace exceeds the runner byte budget.");
      copyFileSync(sourcePath, destinationPath);
    }
  };

  try {
    copyDirectory(source, destination);
    const materialized = materializeWorkspaceFiles(destination, files);
    return {
      cwd: destination,
      copiedFiles,
      copiedBytes,
      workspaceArtifactPaths: materialized.paths,
    };
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupEvolutionWorkspace(cwd) {
  if (!cwd) return;
  rmSync(path.resolve(cwd), { recursive: true, force: true });
}
