const DEFAULT_RETRY_DELAYS_MS = [0, 250, 1000, 3000];
const DEFAULT_TIMEOUT_MS = 5000;

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

export function createRuntimeEventSink({
  runtime,
  runnerToken,
  fetchImpl = globalThis.fetch,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleepImpl = sleep,
}) {
  const normalizedRuntime = asString(runtime);
  const token = asString(runnerToken);
  const queues = new Map();

  if (!normalizedRuntime) throw new Error("Runtime event sink requires a runtime id.");
  if (typeof fetchImpl !== "function") throw new Error("Runtime event sink requires fetch support.");

  async function deliver(run, event) {
    const eventSinkUrl = asHttpUrl(run?.eventSinkUrl);
    const ownerId = asString(run?.ownerId);
    const sessionId = asString(run?.sessionId);
    const journalId = asString(run?.journalId);
    const runId = asString(run?.runId);
    if (!eventSinkUrl || !ownerId || !sessionId || !journalId || !runId || !token) return false;

    const body = JSON.stringify({
      runtime: normalizedRuntime,
      ownerId,
      sessionId,
      projectId: asString(run?.projectId),
      journalId,
      runId,
      event,
    });
    let lastError = null;

    for (let index = 0; index < retryDelaysMs.length; index += 1) {
      const delay = Number(retryDelaysMs[index]) || 0;
      if (delay > 0) await sleepImpl(delay);
      try {
        const response = await fetchImpl(eventSinkUrl, {
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

  function enqueue(run, event) {
    const runId = asString(run?.runId) || "unknown";
    const previous = queues.get(runId) ?? Promise.resolve(false);
    const current = previous
      .catch(() => false)
      .then(() => deliver(run, event));
    queues.set(runId, current);
    void current
      .catch((error) => {
        console.warn("[" + normalizedRuntime + "-runner] runtime event sink delivery failed", error);
        return false;
      })
      .finally(() => {
        if (queues.get(runId) === current) queues.delete(runId);
      });
    return current;
  }

  return { enqueue };
}
