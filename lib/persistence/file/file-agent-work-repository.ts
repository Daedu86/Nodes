import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentEventCreateInput,
  AgentEventRecord,
  AgentTokenRecord,
  AgentTokenUpsertInput,
  AgentWorkListOptions,
  AgentWorkRepository,
} from "@/lib/persistence/agent-work-repository";

type StoredAgentToken = AgentTokenRecord;
type StoredAgentEvent = AgentEventRecord;

const ensureSafeOwnerId = (ownerId: string) => {
  if (!/^[a-zA-Z0-9:_-]+$/.test(ownerId)) {
    throw new Error(`Invalid owner id: ${ownerId}`);
  }
};

const getAgentStoreDir = () =>
  process.env.AGENT_WORK_STORE_DIR
    ? path.resolve(process.env.AGENT_WORK_STORE_DIR)
    : path.join(process.cwd(), "data", "agent-work");

const getTokenDir = (ownerId: string) => {
  ensureSafeOwnerId(ownerId);
  return path.join(getAgentStoreDir(), ownerId, "tokens");
};

const getEventDir = (ownerId: string) => {
  ensureSafeOwnerId(ownerId);
  return path.join(getAgentStoreDir(), ownerId, "events");
};

const safeReadJson = async <T>(filePath: string): Promise<T | null> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

const listJsonFiles = async (dir: string) => {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name));
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

const writeJson = async (filePath: string, value: unknown) => {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
};

const tokenPath = (ownerId: string, tokenId: string) => path.join(getTokenDir(ownerId), `${tokenId}.json`);
const eventPath = (ownerId: string, eventId: string) => path.join(getEventDir(ownerId), `${eventId}.json`);

const sortByDateDesc = <T extends { createdAt: string }>(items: T[]) =>
  [...items].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

export const fileAgentWorkRepository: AgentWorkRepository = {
  async getAgentToken(ownerId, tokenId) {
    const token = await safeReadJson<StoredAgentToken>(tokenPath(ownerId, tokenId));
    if (!token || token.ownerId !== ownerId) {
      return null;
    }
    return token;
  },

  async listAgentTokens(ownerId) {
    const dir = getTokenDir(ownerId);
    const files = await listJsonFiles(dir);
    const tokens: StoredAgentToken[] = [];
    for (const filePath of files) {
      const token = await safeReadJson<StoredAgentToken>(filePath);
      if (token && token.ownerId === ownerId) {
        tokens.push(token);
      }
    }
    return sortByDateDesc(tokens);
  },

  async upsertAgentToken(input: AgentTokenUpsertInput) {
    const now = new Date().toISOString();
    const existing = await safeReadJson<StoredAgentToken>(tokenPath(input.ownerId, input.tokenId));
    const record: StoredAgentToken = {
      tokenId: input.tokenId,
      ownerId: input.ownerId,
      label: input.label ?? null,
      revoked: input.revoked === true ? true : existing?.revoked === true,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: input.lastUsedAt ?? existing?.lastUsedAt ?? null,
      createdAt: existing?.createdAt ?? now,
    };
    await writeJson(tokenPath(input.ownerId, input.tokenId), record);
    return record;
  },

  async revokeAgentToken(ownerId, tokenId) {
    const existing = await safeReadJson<StoredAgentToken>(tokenPath(ownerId, tokenId));
    if (!existing || existing.ownerId !== ownerId) {
      return null;
    }
    const next: StoredAgentToken = {
      ...existing,
      revoked: true,
    };
    await writeJson(tokenPath(ownerId, tokenId), next);
    return next;
  },

  async markAgentTokenUsed(ownerId, tokenId, usedAt) {
    const existing = await safeReadJson<StoredAgentToken>(tokenPath(ownerId, tokenId));
    if (!existing) {
      return;
    }
    const next: StoredAgentToken = {
      ...existing,
      lastUsedAt: usedAt ?? new Date().toISOString(),
    };
    await writeJson(tokenPath(ownerId, tokenId), next);
  },

  async recordAgentEvent(ownerId, input: AgentEventCreateInput) {
    const id = input.id ?? randomUUID();
    const record: StoredAgentEvent = {
      id,
      ownerId,
      tokenId: input.tokenId ?? null,
      eventType: input.eventType,
      method: input.method,
      route: input.route,
      sessionId: input.sessionId ?? null,
      projectId: input.projectId ?? null,
      payload: input.payload ?? {},
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    await writeJson(eventPath(ownerId, id), record);
  },

  async listAgentEvents(ownerId, options: AgentWorkListOptions = {}) {
    const dir = getEventDir(ownerId);
    const files = await listJsonFiles(dir);
    const events: StoredAgentEvent[] = [];
    for (const filePath of files) {
      const event = await safeReadJson<StoredAgentEvent>(filePath);
      if (!event || event.ownerId !== ownerId) continue;
      if (options.tokenId && event.tokenId !== options.tokenId) continue;
      if (options.sessionId && event.sessionId !== options.sessionId) continue;
      if (options.projectId && event.projectId !== options.projectId) continue;
      if (options.eventType && event.eventType !== options.eventType) continue;
      if (options.eventTypePrefix && !event.eventType.startsWith(options.eventTypePrefix)) continue;
      events.push(event);
    }
    const sorted = sortByDateDesc(events);
    const limit = typeof options.limit === "number" ? Math.max(1, Math.min(1000, options.limit)) : 80;
    const offset = typeof options.offset === "number"
      ? Math.max(0, Math.trunc(options.offset))
      : 0;
    return sorted.slice(offset, offset + limit);
  },
};