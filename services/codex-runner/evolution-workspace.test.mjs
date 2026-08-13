import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanupEvolutionWorkspace, createEvolutionWorkspace } from "./evolution-workspace.mjs";

const tempDir = (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix));

test("creates an isolated candidate workspace and overrides authoritative .nodes files", () => {
  const source = tempDir("nodes-evolution-source-");
  const tempRoot = tempDir("nodes-evolution-runs-");
  mkdirSync(path.join(source, ".nodes"), { recursive: true });
  writeFileSync(path.join(source, "model.py"), "print('source')\n", "utf8");
  writeFileSync(path.join(source, ".nodes", "tycho-experiment.json"), "{\"old\":true}\n", "utf8");

  const workspace = createEvolutionWorkspace(source, "run-1", [
    { path: ".nodes/tycho-experiment.json", content: "{\"schemaVersion\":1}\n" },
    { path: ".nodes/candidate.py", content: "print('candidate')\n" },
  ], { tempRoot });

  assert.notEqual(workspace.cwd, source);
  assert.equal(readFileSync(path.join(workspace.cwd, "model.py"), "utf8"), "print('source')\n");
  assert.equal(
    readFileSync(path.join(workspace.cwd, ".nodes", "tycho-experiment.json"), "utf8"),
    "{\"schemaVersion\":1}\n",
  );
  assert.equal(readFileSync(path.join(workspace.cwd, ".nodes", "candidate.py"), "utf8"), "print('candidate')\n");

  cleanupEvolutionWorkspace(workspace.cwd);
  assert.equal(existsSync(workspace.cwd), false);
});

test("skips symlinks and generated directories at any depth", () => {
  const source = tempDir("nodes-evolution-source-");
  const outside = tempDir("nodes-evolution-outside-");
  const tempRoot = tempDir("nodes-evolution-runs-");
  mkdirSync(path.join(source, "packages", "web", "node_modules"), { recursive: true });
  writeFileSync(path.join(source, "packages", "web", "node_modules", "ignored.js"), "ignored", "utf8");
  writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
  symlinkSync(path.join(outside, "secret.txt"), path.join(source, "secret-link"));

  const workspace = createEvolutionWorkspace(source, "run-2", [
    { path: ".nodes/tycho-experiment.json", content: "{}\n" },
  ], { tempRoot });

  assert.equal(existsSync(path.join(workspace.cwd, "packages", "web", "node_modules")), false);
  assert.equal(existsSync(path.join(workspace.cwd, "secret-link")), false);
  cleanupEvolutionWorkspace(workspace.cwd);
});

test("rejects a temporary root nested inside the configured source workspace", () => {
  const source = tempDir("nodes-evolution-source-");
  const tempRoot = path.join(source, ".nodes", "evolution-runs");

  assert.throws(
    () => createEvolutionWorkspace(source, "run-3", [
      { path: ".nodes/tycho-experiment.json", content: "{}\n" },
    ], { tempRoot }),
    /must be outside the configured source workspace/,
  );
});
