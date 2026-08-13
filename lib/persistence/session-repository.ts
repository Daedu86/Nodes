import type { SessionArtifact, SessionContextLink } from "@/lib/session-artifacts";
import type { SessionDocument, SessionSummary, SessionThreadExport } from "@/lib/session-documents";
import type {
  SessionBlobCleanupResult,
  SessionBlobMaintenance,
} from "@/lib/session-blob-store";

export type SessionListOptions = {
  includeArchived?: boolean;
  ownerId?: string;
};

export type SessionCreateInput = {
  artifacts?: SessionArtifact[];
  contextLinks?: SessionContextLink[];
  ownerId?: string;
  snapshot?: SessionThreadExport;
  title?: string | null;
};

export type SessionPatch = {
  archived?: boolean;
  artifacts?: SessionArtifact[];
  contextLinks?: SessionContextLink[];
  snapshot?: SessionThreadExport;
  title?: string | null;
};

export type SessionPatchOptions = {
  expectedVersion: number;
  ownerId?: string;
};

export type SessionReadOptions = {
  claimLegacyOwnership?: boolean;
};

export interface SessionRepository {
  cleanupBlobStore(): Promise<SessionBlobCleanupResult>;
  createSession(input?: SessionCreateInput): Promise<SessionDocument>;
  deleteSession(sessionId: string, ownerId?: string): Promise<void>;
  deleteSessions(sessionIds: string[], ownerId?: string): Promise<void>;
  getSession(
    sessionId: string,
    ownerId?: string,
    options?: SessionReadOptions,
  ): Promise<SessionDocument>;
  getSessionBlobMaintenanceSummary(): Promise<SessionBlobMaintenance>;
  listSessions(options?: SessionListOptions): Promise<SessionSummary[]>;
  patchSession(
    sessionId: string,
    patch: SessionPatch,
    options: SessionPatchOptions,
  ): Promise<SessionDocument>;
}
