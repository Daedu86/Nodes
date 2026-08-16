import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const DEFAULT_RETRY_DELAYS_MS = [0, 250, 1000, 3000];
const DEFAULT_TIMEOUT_MS = 5000;
const OUTBOX_VERSION = 1;

const asString = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

function asHttpUrl(value) {
  const raw = asString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const safeInteger = (value, fallback = 0) =>
  Number.isSafeInteger(value) && value >= 0 ? value : fallback;

const entryHash = (runtime, journalId, eventId) =>
  createHash("sha256").update(`${runtime}:${journalId}:${eventId}`).digest("hex");

function createOutboxEntry(runtime, run, event, ordinal) {
  const eventSinkUrl = asHttpUrl(run?.eventSinkUrl);
  const ownerId = asString(run?.ownerId);
  const sessionId = asString(run?.sessionId);
  const journalId = asString(run?.journalId);
  const runId = asString(run?.runId);
  const eventId = asString(event?.id);
  if (!eventSinkUrl || !ownerId || !sessionId || !journalId || !runId || !eventId) return null;

  return {
    version: OUTBOX_VERSION,
    runtime,
    queuedAt: new Date().toISOString(),
    ordinal,
    eventSinkUrl,
    ownerId,
    sessionId,
    projectId: asString(run?.projectId),
    journalId,
    runId,
    eventId,
    event,
  };
}

function parseOutboxEntry(value, expectedRuntime) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.version !== OUTBOX_VERSION || value.runtime !== expectedRuntime) return null;
  const eventSinkUrl = asHttpUrl(value.eventSinkUrl);
  const ownerId = asString(value.ownerId);
  const sessionId = asString(value.sessionId);
  const journalId = asString(value.journalId);
  const runId = asString(value.runId);
  const eventId = asString(value.eventId);
  if (!eventSinkUrl || !ownerId || !sessionId || !journalId || !runId || !eventId) return null;
  if (!value.event || typeof value.event !== "object" || Array.isArray(value.event)) return null;

  return {
    version: OUTBOX_VERSION,
    runtime: expectedRuntime,
    queuedAt: asString(value.queuedAt) ?? new Date(0).toISOString(),
    ordinal: safeInteger(value.ordinal),
    eventSinkUrl,
    ownerId,
    sessionId,
    projectId: asString(value.projectId),
    journalId,
    runId,
    eventId,
    event: value.event,
  };
}

export function createRuntimeEventSink({
  runtime,
  runnerToken,
  outboxDir = null,
  fetchImpl = globalThis.fetch,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleepImpl = sleep,
}) {
  const normalizedRuntime = asString(runtime);
  const token = asString(runnerToken);
  const durableOutboxDir = asString(outboxDir) ? path.resolve(outboxDir) : null;
  const queues = new Map();
  let ordinal = 0;

  if (!normalizedRuntime) throw new Error("Runtime event sink requires a runtime id.");
  if (typeof fetchImpl !== "function") throw new Error("Runtime event sink requires fetch support.");

  function outboxPath(entry) {
    if (!durableOutboxDir) return null;
    const filename = `${entryHash(normalizedRuntime, entry.journalId, entry.eventId)}.json`;
    return path.join(durableOutboxDir, filename);
  }

  function persist(entry) {
    const filePath = outboxPath(entry);
    if (!filePath) return null;
    mkdirSync(durableOutboxDir, { recursive: true, mode: 0o700 });
    if (existsSync(filePath)) return filePath;
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporaryPath, filePath);
    } finally {
      if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
    }
    return filePath;
  }

  function acknowledge(filePath) {
    if (filePath) rmSync(filePath, { force: true });
  }

  async function deliver(entry) {
    if (!token) return false;
    const body = JSON.stringify({
      runtime: normalizedRuntime,
      ownerId: entry.ownerId,
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      journalId: entry.journalId,
      runId: entry.runId,
      event: entry.event,
    });
    let lastError = null;

    for (let index = 0; index < retryDelaysMs.length; index += 1) {
      const delay = Number(retryDelaysMs[index]) || 0;
      if (delay > 0) await sleepImpl(delay);
      try {
        const response = await fetchImpl(entry.eventSinkUrl, {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) return true;
        const retryable = response.status === 429 || response.status >= 500;
        lastError = new Error("Runtime event sink rejected delivery with status " + response.status + ".");
        if (!retryable) break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("Runtime event sink delivery failed.");
  }

  function schedule(entry, filePath) {
    const queueId = entry.journalId;
    const previous = queues.get(queueId) ?? Promise.resolve(false);
    const current = previous
      .catch(() => false)
      .then(async () => {
        const delivered = await deliver(entry);
        if (delivered) acknowledge(filePath);
        return delivered;
      });
    queues.set(queueId, current);
    void current
      .catch((error) => {
        console.warn("[" + normalizedRuntime + "-runner] runtime event sink delivery failed", error);
        return false;
      })
      .finally(() => {
        if (queues.get(queueId) === current) queues.delete(queueId);
      });
    return current;
  }

  function enqueue(run, event) {
    if (!token) return Promise.resolve(false);
    const entry = createOutboxEntry(normalizedRuntime, run, event, ordinal += 1);
    if (!entry) return Promise.resolve(false);
    const filePath = persist(entry);
    return schedule(entry, filePath);
  }

  async function recover() {
    if (!token || !durableOutboxDir || !existsSync(durableOutboxDir)) {
      return { attempted: 0, delivered: 0, failed: 0 };
    }

    const pending = readdirSync(durableOutboxDir)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const filePath = path.join(durableOutboxDir, name);
        try {
          const entry = parseOutboxEntry(JSON.parse(readFileSync(filePath, "utf8")), normalizedRuntime);
          if (!entry) {
            console.warn("[" + normalizedRuntime + "-runner] ignoring invalid runtime event outbox entry", filePath);
            return [];
          }
          return [{ filePath, entry }];
        } catch (error) {
          console.warn("[" + normalizedRuntime + "-runner] unable to read runtime event outbox entry", filePath, error);
          return [];
        }
      })
      .sort((left, right) => {
        const byTime = left.entry.queuedAt.localeCompare(right.entry.queuedAt);
        if (byTime !== 0) return byTime;
        const byOrdinal = left.entry.ordinal - right.entry.ordinal;
        return byOrdinal || left.filePath.localeCompare(right.filePath);
      });

    const results = await Promise.allSettled(
      pending.map(({ entry, filePath }) => schedule(entry, filePath)),
    );
    const delivered = results.filter((result) => result.status === "fulfilled" && result.value === true).length;
    return {
      attempted: pending.length,
      delivered,
      failed: pending.length - delivered,
    };
  }

  return { enqueue, recover };
}
