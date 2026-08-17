export type ClientHttpError = Error & {
  payload?: unknown;
  status?: number;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

export function getClientHttpErrorMessage(error: unknown, fallback: string) {
  const record = asRecord(error);
  const payload = asRecord(record?.payload);
  const payloadMessage = [payload?.error, payload?.message].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (payloadMessage) return payloadMessage.trim();

  if (typeof record?.status === "number") {
    return `${fallback}: ${record.status}`;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
}

export function normalizeClientError(error: unknown, fallback: string): Error {
  const message = getClientHttpErrorMessage(error, fallback);
  if (error instanceof Error) {
    error.message = message;
    return error;
  }
  return new Error(message);
}

type FetchApiOptions = {
  allowedStatuses?: number[];
};

type StoredResourceIdOptions = {
  urlParam?: string;
};

const buildJsonHeaders = (headers?: HeadersInit) => ({
  "Content-Type": "application/json",
  ...(headers ?? {}),
});

export async function fetchApi(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: FetchApiOptions,
) {
  const response = await fetch(input, {
    ...init,
    headers: buildJsonHeaders(init?.headers),
  });
  if (response.ok || options?.allowedStatuses?.includes(response.status)) {
    return response;
  }

  const error = new Error(`Request failed: ${response.status}`) as ClientHttpError;
  error.status = response.status;
  error.payload = await response.json().catch(() => null);
  throw error;
}

export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit) {
  const response = await fetchApi(input, init);
  return (await response.json()) as T;
}

export function createSerialTaskQueue<T>(fallback: T) {
  let queue = new Promise<T>((resolve) => resolve(fallback));

  return (task: () => Promise<T>) => {
    const next = new Promise<T>((resolve, reject) => {
      const run = () => task().then(resolve, reject);
      void queue.then(run, run);
    });
    queue = next.catch(() => fallback);
    return next;
  };
}

export const buildActiveResourceStorageKey = (
  resourceName: string,
  userId: string | null,
) =>
  userId
    ? `nodes.active-${resourceName}-id.${userId}`
    : `nodes.active-${resourceName}-id.v1`;

export const readStoredResourceId = (
  resourceName: string,
  userId: string | null,
  options?: StoredResourceIdOptions,
) => {
  try {
    const urlValue = options?.urlParam
      ? new URLSearchParams(window.location.search).get(options.urlParam)
      : null;
    if (urlValue && urlValue.length > 0) return urlValue;
    return localStorage.getItem(buildActiveResourceStorageKey(resourceName, userId));
  } catch {
    return null;
  }
};

export const writeStoredResourceId = (
  resourceName: string,
  userId: string | null,
  resourceId: string | null,
) => {
  try {
    const storageKey = buildActiveResourceStorageKey(resourceName, userId);
    if (!resourceId) {
      localStorage.removeItem(storageKey);
      return;
    }
    localStorage.setItem(storageKey, resourceId);
  } catch {
    // ignore storage errors
  }
};

export const dedupeResourceIds = (resourceIds: string[]) =>
  [...new Set(resourceIds)].filter((resourceId) => resourceId.length > 0);

/**
 * Replays the caller's list mutation intent over the latest authoritative list.
 *
 * A queued patch is usually built from render-time state. By the time it runs,
 * another serialized request may already have added or removed ids. Comparing
 * the requested list to the caller's base snapshot gives us an explicit delta:
 * additions are added to the current list, removals are removed from the current
 * list, and unrelated concurrent changes are preserved.
 */
export function reconcileQueuedResourceIds(
  baseResourceIds: string[],
  currentResourceIds: string[],
  requestedResourceIds: string[],
) {
  const base = dedupeResourceIds(baseResourceIds);
  const current = dedupeResourceIds(currentResourceIds);
  const requested = dedupeResourceIds(requestedResourceIds);
  const added = requested.filter((resourceId) => !base.includes(resourceId));
  const removed = new Set(
    base.filter((resourceId) => !requested.includes(resourceId)),
  );

  return dedupeResourceIds([
    ...current.filter((resourceId) => !removed.has(resourceId)),
    ...added,
  ]);
}

export function replaceResourceById<T extends { id: string }>(
  resources: T[],
  resource: T,
) {
  return resources.map((item) => (item.id === resource.id ? resource : item));
}

export function prependUniqueResource<T extends { id: string }>(
  resources: T[],
  resource: T,
) {
  return [resource, ...resources.filter((item) => item.id !== resource.id)];
}

export function removeResourceById<T extends { id: string }>(
  resources: T[],
  resourceId: string,
) {
  return resources.filter((item) => item.id !== resourceId);
}