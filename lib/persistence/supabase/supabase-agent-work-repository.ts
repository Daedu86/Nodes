import { getSupabasePersistenceClient } from "@/lib/persistence/supabase/client";
import {
  ensureData,
  requireOwnerId,
} from "@/lib/persistence/supabase/shared";
import type {
  AgentEventCreateInput,
  AgentEventRecord,
  AgentTokenRecord,
  AgentTokenUpsertInput,
  AgentWorkRepository,
  AgentWorkListOptions,
} from "@/lib/persistence/agent-work-repository";

type AgentTokenRow = {
  token_id: string;
  owner_id: string;
  label: string | null;
  revoked: boolean;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
};

type AgentEventRow = {
  id: string;
  owner_id: string;
  token_id: string | null;
  event_type: string;
  method: string;
  route: string;
  session_id: string | null;
  project_id: string | null;
  payload_json: unknown;
  created_at: string;
};

const normalizePayload = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const toTokenRecord = (row: AgentTokenRow): AgentTokenRecord => ({
  tokenId: row.token_id,
  ownerId: row.owner_id,
  label: row.label,
  revoked: row.revoked === true,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
});

const toEventRecord = (row: AgentEventRow): AgentEventRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  tokenId: row.token_id,
  eventType: row.event_type,
  method: row.method,
  route: row.route,
  sessionId: row.session_id,
  projectId: row.project_id,
  payload: normalizePayload(row.payload_json),
  createdAt: row.created_at,
});

export const supabaseAgentWorkRepository: AgentWorkRepository = {
  async getAgentToken(ownerId, tokenId) {
    requireOwnerId(ownerId);
    const client = getSupabasePersistenceClient();
    const { data, error } = await client
      .from("agent_tokens")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("token_id", tokenId)
      .maybeSingle();
    if (error) {
      throw new Error(error.message || "Failed to load agent token");
    }
    return data ? toTokenRecord(data as AgentTokenRow) : null;
  },

  async listAgentTokens(ownerId) {
    requireOwnerId(ownerId);
    const client = getSupabasePersistenceClient();
    const { data, error } = await client
      .from("agent_tokens")
      .select("*")
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false });
    const rows = ensureData(data, error, "Failed to list agent tokens") as AgentTokenRow[];
    return rows.map(toTokenRecord);
  },

  async upsertAgentToken(input: AgentTokenUpsertInput) {
    requireOwnerId(input.ownerId);
    const client = getSupabasePersistenceClient();
    const now = new Date().toISOString();
    const row = {
      token_id: input.tokenId,
      owner_id: input.ownerId,
      label: input.label,
      revoked: input.revoked === true,
      expires_at: input.expiresAt,
      last_used_at: input.lastUsedAt ?? null,
      created_at: now,
    } satisfies Partial<AgentTokenRow> & { token_id: string; owner_id: string };

    const { data, error } = await client
      .from("agent_tokens")
      .upsert(row, { onConflict: "token_id" })
      .select("*")
      .single();
    const saved = ensureData(data, error, "Failed to upsert agent token") as AgentTokenRow;
    return toTokenRecord(saved);
  },

  async revokeAgentToken(ownerId, tokenId) {
    requireOwnerId(ownerId);
    const client = getSupabasePersistenceClient();
    const { data, error } = await client
      .from("agent_tokens")
      .update({ revoked: true })
      .eq("owner_id", ownerId)
      .eq("token_id", tokenId)
      .select("*")
      .maybeSingle();
    if (error) {
      throw new Error(error.message || "Failed to revoke agent token");
    }
    return data ? toTokenRecord(data as AgentTokenRow) : null;
  },

  async markAgentTokenUsed(ownerId, tokenId, usedAt) {
    requireOwnerId(ownerId);
    const client = getSupabasePersistenceClient();
    const timestamp = usedAt ?? new Date().toISOString();
    const { error } = await client
      .from("agent_tokens")
      .update({ last_used_at: timestamp })
      .eq("owner_id", ownerId)
      .eq("token_id", tokenId);
    if (error) {
      throw new Error(error.message || "Failed to update agent token usage");
    }
  },

  async recordAgentEvent(ownerId, input: AgentEventCreateInput) {
    requireOwnerId(ownerId);
    const client = getSupabasePersistenceClient();
    const now = input.createdAt ?? new Date().toISOString();
    const id = input.id ?? undefined;
    const row = {
      id,
      owner_id: ownerId,
      token_id: input.tokenId ?? null,
      event_type: input.eventType,
      method: input.method,
      route: input.route,
      session_id: input.sessionId ?? null,
      project_id: input.projectId ?? null,
      payload_json: input.payload ?? {},
      created_at: now,
    };

    const request = input.id
      ? client.from("agent_events").upsert(row, { onConflict: "id" })
      : client.from("agent_events").insert(row);
    const { error } = await request;
    if (error) {
      throw new Error(error.message || "Failed to persist agent event");
    }
  },

  async listAgentEvents(ownerId, options: AgentWorkListOptions = {}) {
    requireOwnerId(ownerId);
    const client = getSupabasePersistenceClient();
    const limit = typeof options.limit === "number" ? Math.max(1, Math.min(1000, options.limit)) : 80;
    const offset = typeof options.offset === "number"
      ? Math.max(0, Math.trunc(options.offset))
      : 0;
    let query = client
      .from("agent_events")
      .select("*")
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true });

    if (options.tokenId) query = query.eq("token_id", options.tokenId);
    if (options.sessionId) query = query.eq("session_id", options.sessionId);
    if (options.projectId) query = query.eq("project_id", options.projectId);
    if (options.eventType) query = query.eq("event_type", options.eventType);
    if (options.eventTypePrefix) query = query.like("event_type", `${options.eventTypePrefix}%`);

    const { data, error } = await query.range(offset, offset + limit - 1);
    const rows = ensureData(data, error, "Failed to list agent events") as AgentEventRow[];
    return rows.map(toEventRecord);
  },
};
