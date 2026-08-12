import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readTychoReadiness } from "./tycho-readiness.mjs";

function fakeProcess({ stdout = "", stderr = "", code = 0, error = null, delay = 0 } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = () => { proc.killed = true; };
  queueMicrotask(() => {
    if (stdout) proc.stdout.write(stdout);
    if (stderr) proc.stderr.write(stderr);
    proc.stdout.end();
    proc.stderr.end();
    setTimeout(() => error ? proc.emit("error", error) : proc.emit("close", code), delay);
  });
  return proc;
}

test("doctor ready only for isolated runtimes", async () => {
  let args;
  const result = await readTychoReadiness({
    spawnImpl: (bin, argv, opts) => {
      args = { bin, argv, opts };
      return fakeProcess({ stdout: JSON.stringify({ ok: true, runtime: "docker", image: "tycho:1" }) });
    },
  });
  assert.equal(args.bin, "tycho-experiment");
  assert.deepEqual(args.argv, ["--doctor"]);
  assert.equal(args.opts.shell, false);
  assert.deepEqual(result, {
    tychoReady: true,
    tychoRuntime: "docker",
    tychoImage: "tycho:1",
    tychoStatus: "ready",
  });
});

test("host runtime is rejected", async () => {
  const result = await readTychoReadiness({
    spawnImpl: () => fakeProcess({ stdout: JSON.stringify({ ok: true, runtime: "host", image: "x" }) }),
  });
  assert.equal(result.tychoReady, false);
  assert.equal(result.tychoStatus, "unsupported_runtime");
});

test("missing binary is fail closed", async () => {
  const error = new Error("missing");
  error.code = "ENOENT";
  const result = await readTychoReadiness({ spawnImpl: () => fakeProcess({ error }) });
  assert.equal(result.tychoStatus, "not_installed");
});

test("timeout is fail closed", async () => {
  const proc = fakeProcess({ delay: 100 });
  const result = await readTychoReadiness({ timeoutMs: 5, spawnImpl: () => proc });
  assert.equal(result.tychoStatus, "doctor_timeout");
  assert.equal(proc.killed, true);
});
