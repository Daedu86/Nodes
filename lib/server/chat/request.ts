import { z } from "zod";
import {
  getRequestedModelConfig,
  type ResolvedModelConfig,
} from "@/lib/llm/config";
import {
  normalizeMessages,
  selectMessagesForHistoryMode,
  type NormalizedLlmMessage,
} from "@/lib/llm/messages";
import { LLM_PROVIDER_IDS } from "@/lib/llm/provider-catalog";
import {
  REQUEST_ERROR_CODE_HEADER,
  REQUEST_ERROR_MESSAGE_HEADER,
} from "@/lib/llm/request-errors";
import {
  normalizeLlmContextArtifacts,
  type LlmContextArtifact,
} from "@/lib/session-artifacts";

const MAX_CHAT_REQUEST_BYTES = 20 * 1024 * 1024;
const MAX_CHAT_MESSAGES = 250;
const MAX_MESSAGE_PARTS = 64;
const MAX_TOOLS = 64;
const MAX_CONTEXT_ARTIFACTS = 32;
const MAX_SYSTEM_CHARS = 64 * 1024;
const MAX_TEXT_CONTENT_CHARS = 512 * 1024;
const MAX_ARTIFACT_CONTENT_CHARS = 2 * 1024 * 1024;
const MAX_FULL_TREE_CONTEXT_CHARS = 64 * 1024;

const FULL_TREE_CONTEXT_INTRO =
  "The following messages come from the full conversation tree. They may belong to sibling branches, so treat them as reference context rather than one linear dialogue.";
const FULL_TREE_TRUNCATION_MARKER =
  "\n\n[... middle of full tree context truncated to stay within model limits ...]\n\n";

export const CHAT_REQUEST_ID_HEADER = "x-nodes-request-id";
export const INVALID_CHAT_REQUEST_CODE = "invalid_request";

const providerSchema = z.enum(LLM_PROVIDER_IDS);
const historyModeSchema = z.enum(["last", "full"]);
const contextScopeSchema = z.enum(["parent", "branch", "tree"]);
const chatTriggerSchema = z.enum(["submit-message", "regenerate-message"]);
const boundedIdentifierSchema = z.string().trim().min(1).max(256);
const optionalNullableStringSchema = z.string().max(2_048).nullable().optional();

const contextArtifactSchema = z
  .object({
    id: boundedIdentifierSchema,
    title: z.string().trim().min(1).max(512),
    artifactType: z.enum(["text", "code", "image", "file", "prompt"]),
    semanticType: z
      .enum(["decision", "evidence", "plan", "table", "question", "draft"])
      .nullable()
      .optional(),
    byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    content: z.string().max(MAX_ARTIFACT_CONTENT_CHARS),
    fileName: optionalNullableStringSchema,
    language: optionalNullableStringSchema,
    mimeType: optionalNullableStringSchema,
  })
  .strict();

const scopedContextMessageSchema = z
  .object({
    id: boundedIdentifierSchema.optional(),
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().max(MAX_TEXT_CONTENT_CHARS),
  })
  .strict();

const modelResolutionCustomSchema = z
  .object({
    contextArtifacts: z.array(contextArtifactSchema).max(MAX_CONTEXT_ARTIFACTS).optional(),
    contextMessages: z.array(scopedContextMessageSchema).max(MAX_CHAT_MESSAGES).optional(),
    contextScope: contextScopeSchema.optional(),
    historyMode: historyModeSchema.optional(),
    model: boundedIdentifierSchema.optional(),
    provider: providerSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.contextMessages && value.contextMessages.length > 0 && !value.contextScope) {
      context.addIssue({
        code: "custom",
        message: "A context scope is required when scoped context messages are supplied.",
        path: ["contextScope"],
      });
    }
  });

const modelResolutionSchema = z
  .object({
    historyMode: historyModeSchema.optional(),
    custom: modelResolutionCustomSchema.optional(),
    model: boundedIdentifierSchema.optional(),
    provider: providerSchema.optional(),
  })
  .strict();

const messagePartSchema = z
  .object({
    type: z.string().trim().min(1).max(128),
  })
  .catchall(z.unknown());

const messageContentSchema = z.union([
  z.string().max(MAX_TEXT_CONTENT_CHARS),
  z.array(messagePartSchema).max(MAX_MESSAGE_PARTS),
]);

const chatMessageSchema = z
  .object({
    id: z.string().trim().min(1).max(256).optional(),
    role: z.enum(["system", "user", "assistant"]),
    content: messageContentSchema.optional(),
    parts: z.array(messagePartSchema).max(MAX_MESSAGE_PARTS).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.union([z.string().max(128), z.number().finite()]).optional(),
  })
  .catchall(z.unknown())
  .superRefine((message, context) => {
    const hasContent =
      typeof message.content === "string"
        ? message.content.length > 0
        : Array.isArray(message.content) && message.content.length > 0;
    const hasParts = Array.isArray(message.parts) && message.parts.length > 0;
    if (!hasContent && !hasParts) {
      context.addIssue({
        code: "custom",
        message: "Each message must contain content or at least one part.",
        path: ["content"],
      });
    }
  });

const toolsSchema = z
  .record(z.string().trim().min(1).max(128), z.unknown())
  .superRefine((tools, context) => {
    if (Object.keys(tools).length > MAX_TOOLS) {
      context.addIssue({
        code: "custom",
        message: `A maximum of ${MAX_TOOLS} frontend tools is allowed.`,
      });
    }
  });

export const chatRequestBodySchema = z
  .object({
    id: boundedIdentifierSchema.optional(),
    messages: z.array(chatMessageSchema).max(MAX_CHAT_MESSAGES).default([]),
    system: z.string().max(MAX_SYSTEM_CHARS).optional(),
    tools: toolsSchema.optional(),
    trigger: chatTriggerSchema.optional(),
    runConfig: modelResolutionSchema.optional(),
    metadata: modelResolutionSchema.optional(),
    historyMode: historyModeSchema.optional(),
    model: boundedIdentifierSchema.optional(),
    provider: providerSchema.optional(),
  })
  .strict();

export type ChatRequestBody = z.infer<typeof chatRequestBodySchema>;
export type ChatHistoryMode = z.infer<typeof historyModeSchema>;

export type PreparedChatRequest = {
  body: ChatRequestBody;
  contextArtifacts: LlmContextArtifact[];
  historyMode: ChatHistoryMode | undefined;
  messages: NormalizedLlmMessage[];
  messagesToSend: NormalizedLlmMessage[];
  rawMessages: ChatRequestBody["messages"];
  requestedModel: ResolvedModelConfig;
  system: string | undefined;
  tools: Record<string, unknown> | undefined;
};

type ChatRequestParseResult =
  | { ok: true; body: ChatRequestBody }
  | { ok: false; response: Response };

const getUtf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const formatIssuePath = (path: readonly PropertyKey[]) =>
  path.length > 0 ? path.map((part) => String(part)).join(".") : "$";

const createValidationResponse = (options: {
  message: string;
  status: 400 | 413;
  issues?: Array<{ message: string; path: string }>;
}) => {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
  });
  headers.set(REQUEST_ERROR_CODE_HEADER, INVALID_CHAT_REQUEST_CODE);
  headers.set(REQUEST_ERROR_MESSAGE_HEADER, options.message);

  return new Response(
    JSON.stringify({
      error: {
        code: INVALID_CHAT_REQUEST_CODE,
        message: options.message,
        ...(options.issues?.length ? { issues: options.issues } : {}),
      },
    }),
    {
      headers,
      status: options.status,
    },
  );
};

const clampFullTreeContext = (value: string) => {
  if (value.length <= MAX_FULL_TREE_CONTEXT_CHARS) return value;

  const availableChars = MAX_FULL_TREE_CONTEXT_CHARS - FULL_TREE_TRUNCATION_MARKER.length;
  const headChars = Math.floor(availableChars / 3);
  const tailChars = availableChars - headChars;
  return `${value.slice(0, headChars)}${FULL_TREE_TRUNCATION_MARKER}${value.slice(-tailChars)}`;
};

const normalizeFullTreeContext = (
  scopedMessages: NormalizedLlmMessage[],
): NormalizedLlmMessage[] => {
  if (scopedMessages.length <= 1) return scopedMessages;

  const currentPrompt = scopedMessages.at(-1);
  if (!currentPrompt) return scopedMessages;

  const treeTranscript = scopedMessages
    .slice(0, -1)
    .map((message, index) => {
      const idSuffix = message.id ? ` | id=${message.id}` : "";
      return `[Tree node ${index + 1} | role=${message.role}${idSuffix}]\n${message.content}`;
    })
    .join("\n\n");

  if (!treeTranscript.trim()) return [currentPrompt];

  const contextContent = clampFullTreeContext(
    `${FULL_TREE_CONTEXT_INTRO}\n\n${treeTranscript}`,
  );
  const normalized = normalizeMessages([
    { role: "system", content: contextContent },
    {
      ...(currentPrompt.id ? { id: currentPrompt.id } : {}),
      role: currentPrompt.role,
      content: currentPrompt.content,
    },
  ]);

  return normalized.length > 0 ? normalized : [currentPrompt];
};

export async function parseChatRequest(req: Request): Promise<ChatRequestParseResult> {
  const declaredLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CHAT_REQUEST_BYTES) {
    return {
      ok: false,
      response: createValidationResponse({
        message: "The chat request is too large.",
        status: 413,
      }),
    };
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return {
      ok: false,
      response: createValidationResponse({
        message: "The chat request body could not be read.",
        status: 400,
      }),
    };
  }

  if (getUtf8ByteLength(rawBody) > MAX_CHAT_REQUEST_BYTES) {
    return {
      ok: false,
      response: createValidationResponse({
        message: "The chat request is too large.",
        status: 413,
      }),
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      response: createValidationResponse({
        message: "Invalid JSON body.",
        status: 400,
      }),
    };
  }

  const result = chatRequestBodySchema.safeParse(parsedJson);
  if (!result.success) {
    return {
      ok: false,
      response: createValidationResponse({
        message: "The chat request payload is invalid.",
        status: 400,
        issues: result.error.issues.slice(0, 12).map((issue) => ({
          message: issue.message,
          path: formatIssuePath(issue.path),
        })),
      }),
    };
  }

  return { ok: true, body: result.data };
}

const getDurableMessageCustomConfig = (messages: ChatRequestBody["messages"]) => {
  const message = messages.at(-1);
  if (!message) return undefined;

  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const custom = (metadata as Record<string, unknown>).custom;
  if (!custom || typeof custom !== "object") return undefined;
  const record = custom as Record<string, unknown>;
  const candidate = Object.fromEntries(
    ["contextArtifacts", "contextMessages", "contextScope", "historyMode", "model", "provider"]
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
  const parsed = modelResolutionCustomSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  if (!parsed.data.contextScope || !parsed.data.contextMessages?.length) return undefined;
  return parsed.data;
};

const withDurableModelFallback = (
  body: ChatRequestBody,
  durableMessageCustom: z.infer<typeof modelResolutionCustomSchema> | undefined,
): ChatRequestBody => {
  if (!durableMessageCustom?.model && !durableMessageCustom?.provider) return body;

  return {
    ...body,
    runConfig: {
      ...body.runConfig,
      custom: {
        ...(durableMessageCustom.model ? { model: durableMessageCustom.model } : {}),
        ...(durableMessageCustom.provider ? { provider: durableMessageCustom.provider } : {}),
        ...body.runConfig?.custom,
      },
    },
  };
};

export function prepareChatRequest(body: ChatRequestBody): PreparedChatRequest {
  const rawMessages = body.messages;
  const messages = normalizeMessages(rawMessages);
  const durableMessageCustom = getDurableMessageCustomConfig(rawMessages);
  const effectiveBody = withDurableModelFallback(body, durableMessageCustom);
  const contextArtifacts = normalizeLlmContextArtifacts(
    body.metadata?.custom?.contextArtifacts ??
      body.runConfig?.custom?.contextArtifacts ??
      durableMessageCustom?.contextArtifacts,
  );
  const contextScope =
    body.metadata?.custom?.contextScope ??
    body.runConfig?.custom?.contextScope ??
    durableMessageCustom?.contextScope;
  const historyMode =
    body.metadata?.custom?.historyMode ??
    body.metadata?.historyMode ??
    body.runConfig?.custom?.historyMode ??
    body.runConfig?.historyMode ??
    durableMessageCustom?.historyMode ??
    body.historyMode;
  const scopedMessages = normalizeMessages(
    body.metadata?.custom?.contextMessages ??
      body.runConfig?.custom?.contextMessages ??
      durableMessageCustom?.contextMessages ??
      [],
  );
  const scopedMessagesToSend =
    contextScope === "tree"
      ? normalizeFullTreeContext(scopedMessages)
      : scopedMessages;

  return {
    body: effectiveBody,
    contextArtifacts,
    historyMode,
    messages,
    messagesToSend:
      scopedMessagesToSend.length > 0
        ? scopedMessagesToSend
        : selectMessagesForHistoryMode(messages, historyMode ?? "last"),
    rawMessages,
    requestedModel: getRequestedModelConfig(effectiveBody),
    system: body.system,
    tools: body.tools,
  };
}
