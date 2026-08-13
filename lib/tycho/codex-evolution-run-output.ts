import { normalizeCodexNotification } from "@/lib/agents/codex/event-mapper";
import type {
  CodexCanvasEvent,
  CodexRunnerEventEnvelope,
} from "@/lib/agents/codex/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSseData = (frame: string) => {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  return data && data !== "[DONE]" ? data : null;
};

const parseEnvelope = (data: string): CodexRunnerEventEnvelope => {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error("Codex runner emitted malformed SSE JSON.");
  }
  if (!isRecord(value) || !isRecord(value.notification) || typeof value.notification.method !== "string") {
    throw new Error("Codex runner emitted an invalid event envelope.");
  }
  return value as CodexRunnerEventEnvelope;
};

const completedMessageText = (event: CodexCanvasEvent) => {
  if (event.type !== "agent.message.completed") return null;
  const params = isRecord(event.payload.params) ? event.payload.params : {};
  return typeof params.text === "string" && params.text.trim() ? params.text.trim() : null;
};

const forbiddenSideEffectEvents = new Set<CodexCanvasEvent["type"]>([
  "agent.child.spawned",
  "tool.started",
  "tool.completed",
  "shell.started",
  "shell.completed",
  "file.changed",
]);

export class CodexGeneratorApprovalRequiredError extends Error {}
export class CodexGeneratorSideEffectError extends Error {}
export class CodexGeneratorTimeoutError extends Error {}

export async function consumeCodexGeneratorStream(input: {
  response: Response;
  runId: string;
  timeoutMs: number;
  maxOutputChars: number;
}) {
  if (!input.response.ok || !input.response.body) {
    const message = await input.response.text().catch(() => "Codex event stream unavailable.");
    throw new Error(message || `Codex event stream unavailable: ${input.response.status}`);
  }

  const reader = input.response.body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + input.timeoutMs;
  let buffer = "";
  let latestCompletedMessage: string | null = null;
  let terminal = false;

  const readWithDeadline = async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new CodexGeneratorTimeoutError("Codex variant generation timed out.");
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new CodexGeneratorTimeoutError("Codex variant generation timed out.")),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  const handleFrame = (frame: string) => {
    const data = parseSseData(frame);
    if (!data) return;
    const envelope = parseEnvelope(data);
    const event = normalizeCodexNotification({
      notification: envelope.notification,
      runId: input.runId,
      eventId: envelope.id,
      createdAt: envelope.createdAt,
      threadId: envelope.threadId,
      parentRunId: envelope.parentRunId,
      agentId: envelope.agentId,
    });

    if (event.type === "approval.requested") {
      throw new CodexGeneratorApprovalRequiredError(
        "Codex variant generator requested an approval; hypothesis generation must be side-effect free.",
      );
    }
    if (forbiddenSideEffectEvents.has(event.type)) {
      throw new CodexGeneratorSideEffectError(
        `Codex variant generator attempted forbidden execution activity: ${event.type}.`,
      );
    }
    if (event.type === "run.failed") throw new Error("Codex variant generation run failed.");
    if (event.type === "run.cancelled") throw new Error("Codex variant generation run was cancelled.");

    const text = completedMessageText(event);
    if (text) {
      if (text.length > input.maxOutputChars) {
        throw new Error(`Codex variant generator output exceeds ${input.maxOutputChars} characters.`);
      }
      latestCompletedMessage = text;
    }
    if (event.type === "run.completed") terminal = true;
  };

  try {
    while (!terminal) {
      const chunk = await readWithDeadline();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        handleFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleFrame(buffer);
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (!terminal) throw new Error("Codex variant generation stream ended before run completion.");
  if (!latestCompletedMessage) {
    throw new Error("Codex variant generation completed without a final agent message.");
  }
  return latestCompletedMessage;
}
