const EVENT_SINK_PATH = "/api/agents/runtime-events";

const absoluteHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
};

export function getAgentRuntimeEventSinkUrl(): string | null {
  const explicit = process.env.NODES_RUNTIME_EVENT_SINK_URL?.trim();
  if (explicit) return absoluteHttpUrl(explicit);

  const nextAuthUrl = process.env.NEXTAUTH_URL?.trim();
  if (nextAuthUrl) {
    const base = absoluteHttpUrl(nextAuthUrl);
    if (base) return new URL(EVENT_SINK_PATH, base).toString();
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) {
    const base = absoluteHttpUrl("https://" + vercelUrl);
    if (base) return new URL(EVENT_SINK_PATH, base).toString();
  }

  return null;
}
