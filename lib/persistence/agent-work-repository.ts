export type AgentTokenRecord = {
  tokenId: string;
  ownerId: string;
  label: string | null;
  revoked: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type AgentEventRecord = {
  id: string;
  ownerId: string;
  tokenId: string | null;
  eventType: string;
  method: string;
  route: string;
  sessionId: string | null;
  projectId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AgentEventCreateInput = Omit<AgentEventRecord, "createdAt" | "id"> & {
  id?: string;
  createdAt?: string;
};

export type AgentTokenUpsertInput = {
  tokenId: string;
  ownerId: string;
  label: string | null;
  expiresAt: string | null;
  revoked?: boolean;
  lastUsedAt?: string | null;
};

export type AgentWorkListOptions = {
  limit?: number;
  offset?: number;
  tokenId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
  eventType?: string | null;
  eventTypePrefix?: string | null;
};

export type AgentWorkRepository = {
  getAgentToken: (ownerId: string, tokenId: string) => Promise<AgentTokenRecord | null>;
  listAgentTokens: (ownerId: string) => Promise<AgentTokenRecord[]>;
  revokeAgentToken: (ownerId: string, tokenId: string) => Promise<AgentTokenRecord | null>;
  upsertAgentToken: (input: AgentTokenUpsertInput) => Promise<AgentTokenRecord>;
  markAgentTokenUsed: (ownerId: string, tokenId: string, usedAt?: string) => Promise<void>;
  recordAgentEvent: (ownerId: string, input: AgentEventCreateInput) => Promise<void>;
  listAgentEvents: (ownerId: string, options?: AgentWorkListOptions) => Promise<AgentEventRecord[]>;
};
