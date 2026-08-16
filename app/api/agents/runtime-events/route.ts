import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { AgentRuntimeId } from "@/lib/agents/runtime/types";
import {
  normalizeAgentStreamEvent,
  projectRuntimeEventToJournal,
} from "@/lib/server/agent-stream-journal";
import { loadAgentSessionJournal } from "@/lib/server/agent-session-journal";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const RUNTIMES = new Set<AgentRuntimeId>(["codex", "nooa"]);

const asString = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const tokenForRuntime = (runtimeId: AgentRuntimeId) =>
  (runtimeId === "codex" ? process.env.CODEX_RUNNER_TOKEN : process.env.NOOA_RUNNER_TOKEN)?.trim() || null;

const bearerToken = (req: Request) => {
  const header = req.headers.get("authorization")?.trim() || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
};

const secretsEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function readBody(req: Request) {
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    throw new Error("PAYLOAD_TOO_LARGE");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (error) {
    if (error instanceof Error && error.message === "PAYLOAD_TOO_LARGE") {
      return NextResponse.json({ error: "Runtime event payload is too large." }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid runtime event payload." }, { status: 400 });
  }

  const runtimeId = asString(body.runtime);
  if (!runtimeId || !RUNTIMES.has(runtimeId as AgentRuntimeId)) {
    return NextResponse.json({ error: "Unsupported runtime." }, { status: 400 });
  }
  const runtime = runtimeId as AgentRuntimeId;
  const expectedToken = tokenForRuntime(runtime);
  if (!expectedToken) {
    return NextResponse.json({ error: "Runtime event sink is not configured." }, { status: 503 });
  }
  const suppliedToken = bearerToken(req);
  if (!suppliedToken || !secretsEqual(suppliedToken, expectedToken)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const ownerId = asString(body.ownerId);
  const sessionId = asString(body.sessionId);
  const journalId = asString(body.journalId);
  const runId = asString(body.runId);
  const projectId = asString(body.projectId);
  if (!ownerId || !sessionId || !journalId || !runId || !body.event) {
    return NextResponse.json({ error: "Missing runtime event identity." }, { status: 400 });
  }

  try {
    const journal = await loadAgentSessionJournal({ ownerId, sessionId, journalId });
    if ((journal.identity.projectId ?? null) !== (projectId ?? null)) {
      return NextResponse.json({ error: "Runtime event project identity mismatch." }, { status: 409 });
    }
    const event = normalizeAgentStreamEvent(runtime, body.event, runId);
    if (!event) {
      return NextResponse.json({ error: "Invalid runtime event envelope." }, { status: 400 });
    }
    const projected = await projectRuntimeEventToJournal(journal, event);
    return NextResponse.json({ accepted: true, projected }, { status: projected ? 201 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to persist runtime event.";
    console.warn("[agent-kernel] runtime event callback failed", message);
    return NextResponse.json({ error: "Unable to persist runtime event." }, { status: 503 });
  }
}
