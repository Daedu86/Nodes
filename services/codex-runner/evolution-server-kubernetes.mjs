import http from "node:http";

import { readEvolutionRunnerConfig } from "./evolution-config.mjs";
import { createDurableEvolutionOrchestrator } from "./evolution-orchestrator.mjs";
import { createKubernetesEvolutionBackend } from "./kubernetes-evolution-backend.mjs";

const RUNNER_CONFIG = readEvolutionRunnerConfig();
const PORT = RUNNER_CONFIG.port;
const HOST = process.env.CODEX_RUNNER_HOST || "127.0.0.1";
const RUNNER_TOKEN = process.env.CODEX_RUNNER_TOKEN?.trim() || null;
const backend = createKubernetesEvolutionBackend();
const durable = createDurableEvolutionOrchestrator({ host: "127.0.0.1", evolutionPort: PORT, token: RUNNER_TOKEN });

const asString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function authorize(req) {
  return !RUNNER_TOKEN || req.headers.authorization === `Bearer ${RUNNER_TOKEN}`;
}

function ownerFrom(req, body = {}) {
  return asString(req.headers["x-nodes-owner-id"]) || asString(body.ownerId);
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 700_000) {
        reject(new Error("Evolution request exceeds the runner payload budget."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/healthz") {
    return json(res, 200, {
      ok: true,
      backend: "kubernetes",
      durableEpisodes: durable.activeCount(),
    });
  }
  if (!authorize(req)) return json(res, 401, { error: "Unauthorized." });

  try {
    if (url.pathname === "/readyz" && req.method === "GET") {
      const readiness = await backend.ready();
      return json(res, readiness.ok ? 200 : 503, {
        ...readiness,
        durableEvolution: true,
        executionBackend: "kubernetes",
      });
    }

    if (url.pathname === "/v1/evolution/episodes" && req.method === "POST") {
      const body = await readJson(req);
      const ownerId = ownerFrom(req, body);
      if (!ownerId) return json(res, 400, { error: "Missing owner id." });
      return json(res, 202, await durable.start(body, ownerId));
    }

    const episodeCancelMatch = url.pathname.match(/^\/v1\/evolution\/episodes\/([^/]+)\/cancel$/);
    if (episodeCancelMatch && req.method === "POST") {
      const episode = await durable.cancel(decodeURIComponent(episodeCancelMatch[1]), ownerFrom(req));
      return episode ? json(res, 200, episode) : json(res, 404, { error: "Evolution episode run not found." });
    }

    const episodeMatch = url.pathname.match(/^\/v1\/evolution\/episodes\/([^/]+)$/);
    if (episodeMatch && req.method === "GET") {
      const episode = await durable.get(decodeURIComponent(episodeMatch[1]), ownerFrom(req));
      return episode ? json(res, 200, episode) : json(res, 404, { error: "Evolution episode run not found." });
    }

    if (url.pathname === "/v1/evolution/runs" && req.method === "POST") {
      const body = await readJson(req);
      const ownerId = ownerFrom(req, body);
      if (!ownerId) return json(res, 400, { error: "Missing owner id." });
      return json(res, 202, await backend.start({ ...body, ownerId }));
    }

    const resultMatch = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)\/result$/);
    if (resultMatch && req.method === "GET") {
      const ownerId = ownerFrom(req);
      if (!ownerId) return json(res, 400, { error: "Missing owner id." });
      return json(res, 200, await backend.getResult(ownerId, decodeURIComponent(resultMatch[1])));
    }

    const cancelMatch = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === "POST") {
      const ownerId = ownerFrom(req);
      if (!ownerId) return json(res, 400, { error: "Missing owner id." });
      return json(res, 200, await backend.cancel(ownerId, decodeURIComponent(cancelMatch[1])));
    }

    const runMatch = url.pathname.match(/^\/v1\/evolution\/runs\/([^/]+)$/);
    if (runMatch && req.method === "GET") {
      const ownerId = ownerFrom(req);
      if (!ownerId) return json(res, 400, { error: "Missing owner id." });
      return json(res, 200, await backend.get(ownerId, decodeURIComponent(runMatch[1])));
    }

    return json(res, 404, { error: "Not found." });
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    console.error("[tycho-kubernetes-evolution-runner] request failed", error);
    return json(res, status, { error: error instanceof Error ? error.message : "Internal error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Nodes Tycho Kubernetes Evolution Runner listening on http://${HOST}:${PORT}`);
  void durable.recover();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void durable.shutdown().finally(() => server.close(() => process.exit(0)));
  });
}
