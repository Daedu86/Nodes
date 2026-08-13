import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  EMPTY_SESSION_THREAD_EXPORT,
  getSessionMessageCount,
  normalizeSessionArtifactsDocument,
  normalizeSessionContextLinksDocument,
  normalizeSessionThreadExport,
  type SessionDocument,
  type SessionSummary,
} from "@/lib/session-documents";
import type {
  SessionCreateInput,
  SessionPatch,
  SessionPatchOptions,
  SessionRepository,
} from "@/lib/persistence/session-repository";
import {
  cleanupOrphanedSessionBlobs,
  deleteSessionBlobDir,
  getSessionBlobMaintenance,
  reconcileSessionArtifactBlobs,
} from "@/lib/session-blob-store";
import {
  isValidSessionVersion,
  SessionVersionConflictError,
} from "@/lib/session-version-conflict";

type StoredSession = Omit<SessionDocument, "messageCount"> & {
  ownerId: string | null;
};

const SESSION_FILE_EXTENSION = ".json";

const ensureSafeSessionId = (sessionId: string) => {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
};

export const getSessionStoreDir = () =>
  process.env.SESSION_STORE_DIR
    ? path.resolve(process.env.SESSION_STORE_DIR)
    : path.join(process.cwd(), "data", "sessions");

const getSessionFilePath = (sessionId: string) => {
  ensureSafeSessionId(sessionId);
  return path.join(getSessionStoreDir(), `${sessionId}${SESSION_FILE_EXTENSION}`);
};

const normalizeOwnerId = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : null;

const normalizeVersion = (value: unknown) =>
  isValidSessionVersion(value) ? value : 1;

const toStoredSession = (
  session: SessionDocument,
  ownerId: string | null,
): StoredSession => {
  const { messageCount, ...storedSession } = session;
  void messageCount;
  return {
    ...storedSession,
    ownerId,
  };
};

const toSessionDocument = (storedSession: StoredSession): SessionDocument => {
  const { ownerId, ...session } = storedSession;
  void ownerId;
  const snapshot = normalizeSessionThreadExport(session.snapshot);
  return {
    ...session,
    version: normalizeVersion(session.version),
    snapshot,
    artifacts: normalizeSessionArtifactsDocument(session.artifacts),
    contextLinks: normalizeSessionContextLinksDocument(session.contextLinks),
    messageCount: getSessionMessageCount(snapshot),
  };
};

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => {
    const timeDelta = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    if (timeDelta !== 0) return timeDelta;
    return a.createdAt.localeCompare(b.createdAt);
  });

const isMissingSessionError = (error: unknown) =>
  (error instanceof Error && error.message === "Session not found") ||
  (typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT");

const getSessionWriteLocks = () => {
  const globalState = globalThis as typeof globalThis & {
    __nodesSessionWriteLocks?: Map<string, Promise<void>>;
  };
  if (!globalState.__nodesSessionWriteLocks) {
    globalState.__nodesSessionWriteLocks = new Map();
  }
  return globalState.__nodesSessionWriteLocks;
};

async function withSessionWriteLock<T>(sessionId: string, task: () => Promise<T>) {
  const locks = getSessionWriteLocks();
  const previous = locks.get(sessionId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(sessionId, queued);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (locks.get(sessionId) === queued) {
      locks.delete(sessionId);
    }
  }
}

async function ensureStoreDir() {
  await fs.mkdir(getSessionStoreDir(), { recursive: true });
}

async function writeSessionDocument(session: StoredSession) {
  await ensureStoreDir();
  const filePath = getSessionFilePath(session.id);
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(session, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

async function readSessionDocumentFromPath(filePath: string): Promise<StoredSession> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw) as Partial<StoredSession>;
  const snapshot = normalizeSessionThreadExport(parsed.snapshot);
  return toStoredSession(
    toSessionDocument({
      id: typeof parsed.id === "string" ? parsed.id : path.basename(filePath, SESSION_FILE_EXTENSION),
      title: typeof parsed.title === "string" && parsed.title.trim().length ? parsed.title.trim() : null,
      archived: parsed.archived === true,
      createdAt:
        typeof parsed.createdAt === "string" && parsed.createdAt.length
          ? parsed.createdAt
          : new Date().toISOString(),
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt.length
          ? parsed.updatedAt
          : new Date().toISOString(),
      ownerId: normalizeOwnerId(parsed.ownerId),
      version: normalizeVersion(parsed.version),
      snapshot,
      artifacts: normalizeSessionArtifactsDocument(parsed.artifacts),
      contextLinks: normalizeSessionContextLinksDocument(parsed.contextLinks),
    }),
    normalizeOwnerId(parsed.ownerId),
  );
}

async function readAllSessionDocuments() {
  await ensureStoreDir();
  const entries = await fs.readdir(getSessionStoreDir(), { withFileTypes: true });
  const sessions = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(SESSION_FILE_EXTENSION))
      .map(async (entry) => {
        try {
          return await readSessionDocumentFromPath(
            path.join(getSessionStoreDir(), entry.name),
          );
        } catch (error) {
          // A concurrent delete can remove a file after readdir but before readFile.
          if (isMissingSessionError(error)) {
            return null;
          }
          throw error;
        }
      }),
  );
  return sessions.filter((session): session is StoredSession => session !== null);
}

async function claimSessionOwnerIfNeeded(session: StoredSession, ownerId: string) {
  if (session.ownerId === ownerId) {
    return session;
  }
  if (session.ownerId) {
    return null;
  }
  const claimed = {
    ...session,
    ownerId,
  };
  await writeSessionDocument(claimed);
  return claimed;
}

async function getStoredSession(
  sessionId: string,
  ownerId?: string,
  claimLegacyOwnership = true,
) {
  const session = await readSessionDocumentFromPath(getSessionFilePath(sessionId));
  if (!ownerId) {
    return session;
  }
  if (!session.ownerId && !claimLegacyOwnership) {
    return session;
  }
  const claimed = await claimSessionOwnerIfNeeded(session, ownerId);
  if (!claimed) {
    throw new Error("Session not found");
  }
  return claimed;
}

async function getReferencedBlobRefs() {
  const sessions = await readAllSessionDocuments();
  return sessions.flatMap((session) =>
    session.artifacts
      .map((artifact) => artifact.blobRef)
      .filter((blobRef): blobRef is string => Boolean(blobRef)),
  );
}

export const fileSessionRepository: SessionRepository = {
  async listSessions(options = {}) {
    const includeArchived = options.includeArchived === true;
    const ownerId = typeof options.ownerId === "string" && options.ownerId.length > 0
      ? options.ownerId
      : null;
    let sessions = await readAllSessionDocuments();

    if (ownerId) {
      const visibleSessions: StoredSession[] = [];
      for (const session of sessions) {
        const claimed = await claimSessionOwnerIfNeeded(session, ownerId);
        if (claimed) {
          visibleSessions.push(claimed);
        }
      }
      sessions = visibleSessions;
    }

    const summaries = sessions
      .filter((session) => includeArchived || !session.archived)
      .map<SessionSummary>((storedSession) => {
        const { ownerId: unusedOwnerId, snapshot, ...session } = storedSession;
        void unusedOwnerId;
        return {
          ...session,
          version: normalizeVersion(session.version),
          messageCount: getSessionMessageCount(snapshot),
        };
      });

    return sortSessions(summaries);
  },

  async getSession(sessionId, ownerId, options) {
    return toSessionDocument(await getStoredSession(
      sessionId,
      ownerId,
      options?.claimLegacyOwnership !== false,
    ));
  },

  async createSession(input: SessionCreateInput = {}) {
    const now = new Date().toISOString();
    const session: StoredSession = {
      id: randomUUID(),
      title: typeof input.title === "string" && input.title.trim().length ? input.title.trim() : null,
      archived: false,
      createdAt: now,
      updatedAt: now,
      ownerId: normalizeOwnerId(input.ownerId),
      version: 1,
      snapshot: normalizeSessionThreadExport(input.snapshot ?? EMPTY_SESSION_THREAD_EXPORT),
      artifacts: normalizeSessionArtifactsDocument(input.artifacts),
      contextLinks: normalizeSessionContextLinksDocument(input.contextLinks),
    };
    await writeSessionDocument(session);
    return toSessionDocument(session);
  },

  async patchSession(
    sessionId,
    patch: SessionPatch,
    options: SessionPatchOptions,
  ) {
    return withSessionWriteLock(sessionId, async () => {
      const current = await getStoredSession(sessionId, options.ownerId);
      const currentDocument = toSessionDocument(current);
      if (currentDocument.version !== options.expectedVersion) {
        throw new SessionVersionConflictError(options.expectedVersion, currentDocument);
      }

      const next: StoredSession = {
        id: current.id,
        title:
          patch.title === undefined
            ? current.title
            : typeof patch.title === "string" && patch.title.trim().length
              ? patch.title.trim()
              : null,
        archived: patch.archived ?? current.archived,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
        ownerId: current.ownerId,
        version: currentDocument.version + 1,
        snapshot:
          patch.snapshot === undefined
            ? current.snapshot
            : normalizeSessionThreadExport(patch.snapshot),
        artifacts:
          patch.artifacts === undefined
            ? current.artifacts
            : normalizeSessionArtifactsDocument(patch.artifacts),
        contextLinks:
          patch.contextLinks === undefined
            ? current.contextLinks
            : normalizeSessionContextLinksDocument(patch.contextLinks),
      };
      await reconcileSessionArtifactBlobs(current.artifacts, next.artifacts);
      await writeSessionDocument(next);
      return toSessionDocument(next);
    });
  },

  async deleteSession(sessionId, ownerId) {
    const session = await getStoredSession(sessionId, ownerId);
    await fs.rm(getSessionFilePath(session.id), { force: true });
    await deleteSessionBlobDir(session.id);
  },

  async deleteSessions(sessionIds, ownerId) {
    const uniqueSessionIds = [...new Set(sessionIds)];
    await Promise.all(uniqueSessionIds.map(async (sessionId) => {
      try {
        await fileSessionRepository.deleteSession(sessionId, ownerId);
      } catch (error) {
        if (!isMissingSessionError(error)) {
          throw error;
        }
      }
    }));
  },

  async getSessionBlobMaintenanceSummary() {
    return getSessionBlobMaintenance(await getReferencedBlobRefs());
  },

  async cleanupBlobStore() {
    return cleanupOrphanedSessionBlobs(await getReferencedBlobRefs());
  },
};
