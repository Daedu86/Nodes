import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  materializeWorkspaceFiles,
  normalizeWorkspaceFiles,
} from "./workspace-artifacts.mjs";

const tempWorkspace = () => mkdtempSync(path.join(os.tmpdir(), "nodes-workspace-artifacts-"));

test("materializes authoritative .nodes artifacts once and reuses identical content", () => {
  const cwd = tempWorkspace();
  const input = [{ path: ".nodes/tycho-experiment.json", content: "{}\n" }];
  const first = materializeWorkspaceFiles(cwd, input);
  const second = materializeWorkspaceFiles(cwd, input);

  assert.equal(first.created, 1);
  assert.equal(first.unchanged, 0);
  assert.equal(second.created, 0);
  assert.equal(second.unchanged, 1);
  assert.equal(readFileSync(path.join(cwd, ".nodes/tycho-experiment.json"), "utf8"), "{}\n");
});

test("rejects traversal and non-.nodes paths", () => {
  assert.throws(
    () => normalizeWorkspaceFiles([{ path: "../escape.txt", content: "no" }]),
    /explicit \.nodes\/ relative path/,
  );
  assert.throws(
    () => normalizeWorkspaceFiles([{ path: ".nodes/../escape.txt", content: "no" }]),
    /Invalid runner workspace artifact path/,
  );
});

test("fails closed when an existing workspace file conflicts with the primary session", () => {
  const cwd = tempWorkspace();
  materializeWorkspaceFiles(cwd, [{ path: ".nodes/experiment.py", content: "print('a')\n" }]);
  writeFileSync(path.join(cwd, ".nodes/experiment.py"), "print('b')\n", "utf8");
  assert.throws(
    () => materializeWorkspaceFiles(cwd, [{ path: ".nodes/experiment.py", content: "print('a')\n" }]),
    /authoritative primary-session artifact/,
  );
});

test("rejects symlink traversal inside .nodes", () => {
  const cwd = tempWorkspace();
  const outside = tempWorkspace();
  materializeWorkspaceFiles(cwd, []);
  symlinkSync(outside, path.join(cwd, ".nodes"), "dir");
  assert.throws(
    () => materializeWorkspaceFiles(cwd, [{ path: ".nodes/protocol.json", content: "{}" }]),
    /symbolic link/,
  );
});
