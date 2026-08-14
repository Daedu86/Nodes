"use client";

import React from "react";
import {
  Activity,
  ArrowLeft,
  Bot,
  CheckCircle2,
  Clock3,
  Coins,
  ExternalLink,
  FolderKanban,
  Gauge,
  KeyRound,
  MessageSquareText,
  Power,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useWorkspaceSurface } from "@/components/context/workspace-surface";
import { usePersistedSessions } from "@/components/context/persisted-sessions";
import { useProjects } from "@/components/context/projects";
import { Button } from "@/components/ui/button";
import {
  CODEX_MODEL_OPTIONS,
  CODEX_TOOL_OPTIONS,
  readCodexAgentDefaults,
  writeCodexAgentDefaults,
  type CodexAgentDefaults,
  type CodexAgentTool,
} from "@/lib/agents/codex/defaults";

type AgentWorkAgent = {
  tokenId: string;
  label: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  eventCount: number;
  sessionIds: string[];
  projectIds: string[];
  connected?: boolean;
  model?: string | null;
};

type CodexUsageSnapshot = {
  ok?: boolean;
  account?: unknown;
  rateLimits?: unknown;
  usage?: unknown;
  updatedAt?: string;
  error?: string;
} | null;

type AgentWorkResponse = {
  agents: AgentWorkAgent[];
  sessions: Array<{ id: string; title: string | null; updatedAt: string; createdAt: string; archived: boolean; messageCount: number }>;
  projects: Array<{ id: string; title: string | null; updatedAt: string; createdAt: string; sessionCount: number }>;
  events: Array<{ id: string; tokenId: string | null; eventType: string; method: string; route: string; sessionId: string | null; projectId: string | null; createdAt: string }>;
  codexUsage?: CodexUsageSnapshot;
};

type RunnerControlAction =
  | "runtime.start"
  | "runtime.stop"
  | "auth.login"
  | "auth.logout"
  | "workspace.attach"
  | "workspace.detach"
  | "tycho.verify";

type RunnerControlStatus = {
  activeRunCount: number;
  authenticated: boolean;
  codexRunning: boolean;
  controlAvailable: boolean;
  hasDefaultWorkspace: boolean;
  model: string | null;
  ok: boolean;
  reachable: boolean;
  tychoImage: string | null;
  tychoReady: boolean;
  tychoRuntime: string | null;
  tychoStatus: string | null;
  workspaceConfigured: boolean;
  workspaceCount: number;
  workspaceManaged: boolean;
};

type RunnerLoginPrompt = {
  loginId: string | null;
  userCode: string;
  verificationUrl: string;
};

type RunnerControlResponse = {
  error?: string | null;
  login?: RunnerLoginPrompt | null;
  status?: RunnerControlStatus;
};

const workspaceBackdropClassName =
  "flex flex-1 flex-col overflow-hidden bg-[linear-gradient(180deg,rgba(11,13,19,0.92),rgba(9,11,16,0.98))]";
const shellClassName =
  "h-full min-h-0 overflow-hidden rounded-[20px] border border-border/80 bg-card/94 shadow-[0_20px_54px_-38px_rgba(0,0,0,0.7)] backdrop-blur-md";
const shellInnerClassName =
  "h-full min-h-0 overflow-auto rounded-[18px] bg-background/92 p-5 md:p-6";

const formatDate = (value: string | null) => {
  if (!value) return "never";
  try { return new Date(value).toLocaleString(); } catch { return value; }
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const numberValue = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
};

const stringValue = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const formatResetAt = (value: unknown) => {
  const numeric = numberValue(value);
  const date = numeric !== null
    ? new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000)
    : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Not reported";
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return `Reset due · ${date.toLocaleString()}`;
  const totalMinutes = Math.max(1, Math.round(diffMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const relative = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return `Resets in ${relative} · ${date.toLocaleString()}`;
};

const formatWindow = (minutes: number | null, fallback: string) => {
  if (!minutes) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
};

function UsageWindow({ title, value }: { title: string; value: Record<string, unknown> }) {
  const used = numberValue(value.usedPercent, value.used_percent, value.percentUsed, value.percent_used);
  const windowMinutes = numberValue(value.windowDurationMins, value.window_duration_mins, value.windowMinutes);
  const resetAt = value.resetsAt ?? value.resets_at ?? value.resetAt ?? value.reset_at;
  const safeUsed = used === null ? null : Math.min(100, Math.max(0, used));
  const available = safeUsed === null ? null : Math.max(0, 100 - safeUsed);
  return (
    <div className="rounded-[16px] border border-border/70 bg-background/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-sm font-semibold">{formatWindow(windowMinutes, title)}</p><p className="mt-1 text-xs text-muted-foreground">{formatResetAt(resetAt)}</p></div>
        <span className="text-sm font-semibold text-sky-600">{available === null ? "—" : `${Math.round(available)}% available`}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${available ?? 0}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{safeUsed === null ? "Usage percentage not reported by Codex." : `${Math.round(safeUsed)}% used`}</p>
    </div>
  );
}

function ControlSwitch({
  checked,
  detail,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  detail: string;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-[16px] border border-border/70 bg-background/70 p-4">
      <div className="min-w-0">
        <p className="text-sm font-semibold">{label}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onChange}
        className={`relative h-7 w-12 shrink-0 rounded-full border transition ${
          checked
            ? "border-emerald-500/40 bg-emerald-500"
            : "border-border bg-muted"
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span
          className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition ${
            checked ? "left-[25px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

export function AgentWorkWorkspace() {
  const { showWorkspace } = useWorkspaceSurface();
  const { selectSession } = usePersistedSessions();
  const { selectProject } = useProjects();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const [selectedTokenId, setSelectedTokenId] = React.useState<string | null>(null);
  const [payload, setPayload] = React.useState<AgentWorkResponse | null>(null);
  const [defaults, setDefaults] = React.useState<CodexAgentDefaults>(() => readCodexAgentDefaults());
  const [selectedRunnerProjectId, setSelectedRunnerProjectId] = React.useState<string | null>(null);
  const [runnerStatus, setRunnerStatus] = React.useState<RunnerControlStatus | null>(null);
  const [runnerError, setRunnerError] = React.useState("");
  const [runnerAction, setRunnerAction] = React.useState<RunnerControlAction | "bridge" | null>(null);
  const [loginPrompt, setLoginPrompt] = React.useState<RunnerLoginPrompt | null>(null);

  const refresh = React.useCallback(async (tokenId?: string | null) => {
    setBusy(true);
    setError("");
    try {
      const url = new URL("/api/agents/work", window.location.origin);
      const resolvedTokenId = tokenId ?? selectedTokenId;
      if (resolvedTokenId) url.searchParams.set("tokenId", resolvedTokenId);
      const res = await fetch(url.toString(), { method: "GET", cache: "no-store" });
      if (!res.ok) throw new Error(`Request failed: ${res.status}`);
      const data = (await res.json()) as AgentWorkResponse;
      setPayload(data);
      setSelectedTokenId((current) => {
        const preferred = tokenId === undefined ? current : tokenId;
        return preferred && data.agents.some((agent) => agent.tokenId === preferred)
          ? preferred
          : data.agents[0]?.tokenId ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load agent work.");
    } finally { setBusy(false); }
  }, [selectedTokenId]);

  const deleteToken = React.useCallback(async (tokenId: string) => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/agents/token?tokenId=${encodeURIComponent(tokenId)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || `Request failed: ${res.status}`);
      }
      await refresh(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete agent token.");
    } finally { setBusy(false); }
  }, [refresh]);

  const refreshRunner = React.useCallback(async (workspaceId?: string | null) => {
    setRunnerError("");
    try {
      const selectedId = workspaceId === undefined ? selectedRunnerProjectId : workspaceId;
      const query = selectedId ? `?workspaceId=${encodeURIComponent(selectedId)}` : "";
      const res = await fetch(`/api/agents/codex/control${query}`, {
        method: "GET",
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as RunnerControlResponse | null;
      if (!res.ok || !body?.status) throw new Error(body?.error || `Request failed: ${res.status}`);
      setRunnerStatus(body.status);
      setRunnerError(body.error || "");
    } catch (err) {
      setRunnerStatus(null);
      setRunnerError(err instanceof Error ? err.message : "Unable to load runner controls.");
    }
  }, [selectedRunnerProjectId]);

  const applyRunnerControl = React.useCallback(async (action: RunnerControlAction) => {
    setRunnerAction(action);
    setRunnerError("");
    try {
      const res = await fetch("/api/agents/codex/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, workspaceId: selectedRunnerProjectId }),
      });
      const body = (await res.json().catch(() => null)) as RunnerControlResponse | null;
      if (!res.ok || !body?.status) throw new Error(body?.error || `Request failed: ${res.status}`);
      setRunnerStatus(body.status);
      if (body.login) setLoginPrompt(body.login);
      if (action === "auth.logout") setLoginPrompt(null);
    } catch (err) {
      setRunnerError(err instanceof Error ? err.message : "Unable to apply runner control.");
    } finally {
      setRunnerAction(null);
    }
  }, [selectedRunnerProjectId]);

  const launchLocalBridge = React.useCallback(() => {
    setRunnerAction("bridge");
    setRunnerError("");
    window.location.assign(runnerStatus?.reachable ? "nodes-runner://stop" : "nodes-runner://start");
    window.setTimeout(() => {
      setRunnerAction(null);
      void refreshRunner();
    }, 3_000);
  }, [refreshRunner, runnerStatus?.reachable]);

  React.useEffect(() => {
    void refresh(null);
    void refreshRunner(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    const timer = window.setInterval(() => void refresh(selectedTokenId), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh, selectedTokenId]);
  React.useEffect(() => {
    if (selectedRunnerProjectId || !payload?.projects.length) return;
    setSelectedRunnerProjectId(payload.projects[0]?.id ?? null);
  }, [payload?.projects, selectedRunnerProjectId]);
  React.useEffect(() => {
    if (!selectedRunnerProjectId) return;
    void refreshRunner(selectedRunnerProjectId);
    const timer = window.setInterval(() => void refreshRunner(selectedRunnerProjectId), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshRunner, selectedRunnerProjectId]);

  const toggleTool = (tool: CodexAgentTool) => {
    setDefaults((current) => ({
      ...current,
      tools: current.tools.includes(tool)
        ? current.tools.filter((item) => item !== tool)
        : [...current.tools, tool],
    }));
  };

  const saveDefaults = () => {
    writeCodexAgentDefaults(defaults);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  const agents = payload?.agents ?? [];
  const events = payload?.events ?? [];
  const selectedAgent = agents.find((agent) => agent.tokenId === selectedTokenId) ?? null;
  const sessionsById = React.useMemo(() => new Map((payload?.sessions ?? []).map((item) => [item.id, item])), [payload?.sessions]);
  const projectsById = React.useMemo(() => new Map((payload?.projects ?? []).map((item) => [item.id, item])), [payload?.projects]);

  const rateLimitsEnvelope = asRecord(payload?.codexUsage?.rateLimits);
  const rateLimits = asRecord(rateLimitsEnvelope.rateLimits ?? rateLimitsEnvelope.rate_limits ?? rateLimitsEnvelope);
  const primary = asRecord(rateLimits.primary ?? rateLimits.primaryLimit ?? rateLimits.primary_limit);
  const secondary = asRecord(rateLimits.secondary ?? rateLimits.secondaryLimit ?? rateLimits.secondary_limit);
  const credits = asRecord(rateLimits.credits ?? rateLimits.creditBalance ?? rateLimits.credit_balance);
  const resetCredits = asRecord(rateLimits.rateLimitResetCredits ?? rateLimits.rate_limit_reset_credits ?? rateLimits.resetCredits);
  const account = asRecord(payload?.codexUsage?.account);
  const plan = stringValue(rateLimits.planType, rateLimits.plan_type, account.planType, account.plan_type, account.type);
  const creditBalance = numberValue(credits.balance, credits.amount, credits.remaining);
  const resetCount = numberValue(resetCredits.availableCount, resetCredits.available_count, resetCredits.count);
  const usageEnvelope = asRecord(payload?.codexUsage?.usage);
  const usage = asRecord(usageEnvelope.usage ?? usageEnvelope);
  const tokenTotal = numberValue(usage.totalTokens, usage.total_tokens, usage.tokens, usage.tokenCount, usage.token_count);
  const codexConnected = agents.find((agent) => agent.tokenId === "codex-runtime")?.connected ?? false;

  return (
    <div className={workspaceBackdropClassName}>
      <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-[12px] border border-border/80 bg-muted/60"><Activity className="size-4" /></div>
          <div><h1 className="text-base font-semibold">Agent Work</h1><p className="mt-1 text-sm text-muted-foreground">Control local execution, configure agent defaults, and audit activity.</p></div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={busy || runnerAction !== null} onClick={() => { void refresh(selectedTokenId); void refreshRunner(); }}><RefreshCw className={`size-4 ${busy || runnerAction !== null ? "animate-spin" : ""}`} />Refresh</Button>
          <Button variant="outline" size="sm" onClick={showWorkspace}><ArrowLeft className="size-4" />Back</Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-5">
        <div className={shellClassName}><div className={shellInnerClassName}>
          {error ? <p className="mb-4 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm text-rose-700">{error}</p> : null}

          <section className="mb-5 rounded-[18px] border border-violet-500/25 bg-violet-500/[0.05] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2"><Power className="size-4 text-violet-500" /><p className="text-xs font-medium uppercase tracking-[0.14em] text-violet-600">Local execution</p></div>
                <h2 className="mt-1 text-lg font-semibold">Runner control plane</h2>
                <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">Start the installed runner and ngrok launcher, sign Codex in with a device code, map a project to the runner-owned default workspace, and verify Tycho isolation here.</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${runnerStatus?.reachable ? "bg-emerald-500/15 text-emerald-600" : "bg-rose-500/15 text-rose-600"}`}>{runnerStatus?.reachable ? "● Bridge online" : "● Bridge offline"}</span>
                {runnerStatus?.model ? <span className="rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium">{runnerStatus.model}</span> : null}
              </div>
            </div>

            <div className="mt-5 grid gap-3 lg:grid-cols-2">
              <ControlSwitch
                checked={Boolean(runnerStatus?.reachable)}
                detail={runnerStatus?.reachable ? "The installed launcher, ngrok tunnel, and Nodes runner are reachable." : "Starts the installed Windows launcher for the runner and secure ngrok tunnel—no terminal command each time."}
                disabled={runnerAction !== null}
                label="Runner + secure tunnel"
                onChange={launchLocalBridge}
              />
              <ControlSwitch
                checked={Boolean(runnerStatus?.codexRunning)}
                detail={runnerStatus?.activeRunCount ? `${runnerStatus.activeRunCount} active run${runnerStatus.activeRunCount === 1 ? "" : "s"}; stop is locked until they finish.` : "Starts or stops Codex app-server behind the runner."}
                disabled={!runnerStatus?.reachable || !runnerStatus.controlAvailable || runnerAction !== null || Boolean(runnerStatus?.activeRunCount && runnerStatus.codexRunning)}
                label="Codex runtime"
                onChange={() => void applyRunnerControl(runnerStatus?.codexRunning ? "runtime.stop" : "runtime.start")}
              />
              <ControlSwitch
                checked={Boolean(runnerStatus?.authenticated)}
                detail={runnerStatus?.authenticated ? "Codex is signed in on the runner machine; credentials never enter Nodes." : "Creates a secure Codex device sign-in link without running codex login in a terminal."}
                disabled={!runnerStatus?.codexRunning || !runnerStatus.controlAvailable || runnerAction !== null}
                label="Codex authentication"
                onChange={() => void applyRunnerControl(runnerStatus?.authenticated ? "auth.logout" : "auth.login")}
              />
              <ControlSwitch
                checked={Boolean(runnerStatus?.workspaceConfigured)}
                detail={runnerStatus?.workspaceConfigured ? "This project is mapped to a runner-owned workspace." : runnerStatus?.hasDefaultWorkspace ? "Maps the selected project to the trusted default workspace; no browser filesystem path is accepted." : "Configure one trusted default workspace once on the runner before enabling project mappings."}
                disabled={!selectedRunnerProjectId || !runnerStatus?.reachable || !runnerStatus.controlAvailable || !runnerStatus.hasDefaultWorkspace || runnerAction !== null}
                label="Project workspace"
                onChange={() => void applyRunnerControl(runnerStatus?.workspaceConfigured ? "workspace.detach" : "workspace.attach")}
              />
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto]">
              <label className="space-y-2">
                <span className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Project to control</span>
                <select
                  value={selectedRunnerProjectId ?? ""}
                  onChange={(event) => setSelectedRunnerProjectId(event.target.value || null)}
                  className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"
                >
                  {payload?.projects.length ? null : <option value="">No saved projects</option>}
                  {(payload?.projects ?? []).map((project) => <option key={project.id} value={project.id}>{project.title?.trim() || project.id}</option>)}
                </select>
              </label>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant={runnerStatus?.tychoReady ? "outline" : "default"}
                  disabled={!runnerStatus?.reachable || !runnerStatus.controlAvailable || runnerAction !== null}
                  onClick={() => void applyRunnerControl("tycho.verify")}
                  className="w-full gap-2 lg:w-auto"
                >
                  <ShieldCheck className="size-4" />
                  {runnerStatus?.tychoReady ? "Tycho isolated · Verify again" : "Verify Tycho isolation"}
                </Button>
              </div>
            </div>

            {loginPrompt ? (
              <div className="mt-4 rounded-[16px] border border-sky-500/30 bg-sky-500/[0.07] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div><div className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="size-4 text-sky-600" />Finish Codex sign-in</div><p className="mt-1 text-xs text-muted-foreground">Open the verification page and enter this one-time code.</p></div>
                  <code className="rounded-lg border border-sky-500/25 bg-background px-3 py-2 text-base font-semibold tracking-[0.16em]">{loginPrompt.userCode}</code>
                </div>
                <a href={loginPrompt.verificationUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-sky-700 hover:underline">Open verification page <ExternalLink className="size-3.5" /></a>
              </div>
            ) : null}

            {runnerError ? <p className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2 text-sm leading-6 text-amber-800">{runnerError}</p> : null}
            {!runnerStatus?.controlAvailable && runnerStatus?.reachable ? <p className="mt-3 text-xs text-muted-foreground">The connected runner is an older build. Update it once to unlock these controls.</p> : null}
          </section>

          <section className="mb-5 rounded-[18px] border border-emerald-500/20 bg-emerald-500/[0.04] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2"><Gauge className="size-4 text-emerald-500" /><p className="text-xs font-medium uppercase tracking-[0.14em] text-emerald-600">Codex usage & limits</p></div>
                <h2 className="mt-1 text-lg font-semibold">Account capacity</h2>
                <p className="mt-1 text-sm text-muted-foreground">Live values reported by your local Codex app-server. Refreshes every 60 seconds.</p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${codexConnected ? "bg-emerald-500/15 text-emerald-600" : "bg-rose-500/15 text-rose-600"}`}>{codexConnected ? "● Codex connected" : "● Codex offline"}</span>
                {plan ? <span className="rounded-full border border-border bg-background px-2.5 py-1 text-xs font-medium">{plan}</span> : null}
              </div>
            </div>

            {payload?.codexUsage ? (
              <div className="mt-5 grid gap-3 xl:grid-cols-2">
                {Object.keys(primary).length ? <UsageWindow title="Primary limit" value={primary} /> : <div className="rounded-[16px] border border-border/70 bg-background/70 p-4 text-sm text-muted-foreground">Primary usage window was not reported by this Codex build/account.</div>}
                {Object.keys(secondary).length ? <UsageWindow title="Secondary limit" value={secondary} /> : <div className="rounded-[16px] border border-border/70 bg-background/70 p-4 text-sm text-muted-foreground">Secondary usage window was not reported by this Codex build/account.</div>}
              </div>
            ) : (
              <div className="mt-5 rounded-[16px] border border-amber-500/25 bg-amber-500/[0.06] p-4 text-sm text-muted-foreground">Usage data is not available yet. Restart the local Codex Runner after pulling this update, then refresh Agent Work.</div>
            )}

            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div className="rounded-[16px] border border-border/70 bg-background/70 p-4"><div className="flex items-center gap-2 text-sm font-semibold"><Coins className="size-4 text-amber-500" />Credits</div><p className="mt-2 text-xl font-semibold">{creditBalance === null ? "—" : creditBalance.toLocaleString()}</p><p className="mt-1 text-xs text-muted-foreground">{Object.keys(credits).length ? "Reported account balance" : "Not reported for this account"}</p></div>
              <div className="rounded-[16px] border border-border/70 bg-background/70 p-4"><div className="flex items-center gap-2 text-sm font-semibold"><RefreshCw className="size-4 text-violet-500" />Banked resets</div><p className="mt-2 text-xl font-semibold">{resetCount === null ? "—" : Math.round(resetCount)}</p><p className="mt-1 text-xs text-muted-foreground">Available reset credits</p></div>
              <div className="rounded-[16px] border border-border/70 bg-background/70 p-4"><div className="flex items-center gap-2 text-sm font-semibold"><Clock3 className="size-4 text-sky-500" />Token activity</div><p className="mt-2 text-xl font-semibold">{tokenTotal === null ? "—" : tokenTotal.toLocaleString()}</p><p className="mt-1 text-xs text-muted-foreground">{tokenTotal === null ? "Detailed token total not reported" : "Reported tokens"}</p></div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Last update: {payload?.codexUsage?.updatedAt ? formatDate(payload.codexUsage.updatedAt) : "not available"}</p>
          </section>

          <section className="mb-5 rounded-[18px] border border-sky-500/25 bg-sky-500/[0.06] p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div><p className="text-xs font-medium uppercase tracking-[0.14em] text-sky-600">Agent defaults</p><h2 className="mt-1 text-lg font-semibold">Defaults for new Canvas agents</h2><p className="mt-1 text-sm text-muted-foreground">New nodes inherit these settings. Existing nodes keep their own configuration.</p></div>
              <Button onClick={saveDefaults}><Save className="size-4" />{saved ? "Saved" : "Save defaults"}</Button>
            </div>
            <div className="mt-5 grid gap-4 lg:grid-cols-4">
              <label className="space-y-2"><span className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Default model</span><select value={defaults.model} onChange={(event) => setDefaults((current) => ({ ...current, model: event.target.value }))} className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm">{CODEX_MODEL_OPTIONS.map((model) => <option key={model} value={model}>{model}</option>)}</select></label>
              <div className="space-y-2"><span className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Default tools</span><div className="flex min-h-10 flex-wrap gap-2">{CODEX_TOOL_OPTIONS.map((tool) => <button key={tool} type="button" onClick={() => toggleTool(tool)} className={`rounded-lg border px-3 py-2 text-xs font-medium ${defaults.tools.includes(tool) ? "border-sky-500/40 bg-sky-500/12 text-sky-700" : "border-border bg-background text-muted-foreground"}`}>{tool}</button>)}</div></div>
              <label className="space-y-2"><span className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Workspace</span><select value={defaults.workspace} onChange={(event) => setDefaults((current) => ({ ...current, workspace: event.target.value as CodexAgentDefaults["workspace"] }))} className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"><option value="temporary">Temporary</option><option value="project">Current project</option></select></label>
              <label className="space-y-2"><span className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Approval mode</span><select value={defaults.approvalMode} onChange={(event) => setDefaults((current) => ({ ...current, approvalMode: event.target.value as CodexAgentDefaults["approvalMode"] }))} className="h-10 w-full rounded-xl border border-border bg-background px-3 text-sm"><option value="ask">Ask before risky actions</option><option value="auto">Auto approve</option></select></label>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
            <section className="rounded-[18px] border border-border/80 bg-card/88 p-4">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Agents</p>
              <div className="mt-3 space-y-2">
                {agents.length === 0 ? <p className="text-sm text-muted-foreground">No agents recorded yet.</p> : null}
                {agents.map((agent) => <button key={agent.tokenId} type="button" onClick={() => { setSelectedTokenId(agent.tokenId); void refresh(agent.tokenId); }} className={`w-full rounded-[16px] border px-4 py-3 text-left transition ${agent.tokenId === selectedTokenId ? "border-sky-500/40 bg-sky-500/10" : "border-border/70 bg-background/70 hover:bg-background/90"}`}><div className="flex items-center justify-between gap-2"><p className="truncate text-sm font-semibold">{agent.label?.trim() || "Unnamed agent"}</p>{agent.tokenId === "codex-runtime" ? <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${agent.connected ? "bg-emerald-500/15 text-emerald-600" : "bg-rose-500/15 text-rose-600"}`}>{agent.connected ? "Connected" : "Offline"}</span> : null}</div><p className="mt-1 text-xs text-muted-foreground">{agent.model ? `${agent.model} · ` : ""}{agent.eventCount} events</p></button>)}
              </div>
            </section>

            <section className="rounded-[18px] border border-border/80 bg-card/88 p-4">
              <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Activity</p>
              {!selectedAgent ? <p className="mt-3 text-sm text-muted-foreground">Select an agent to see its activity.</p> : <>
                <div className="mt-3 rounded-[16px] border border-border/70 bg-background/70 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><Bot className="size-4" /><p className="font-semibold">{selectedAgent.label?.trim() || "Unnamed agent"}</p>{selectedAgent.connected ? <CheckCircle2 className="size-4 text-emerald-500" /> : null}</div><p className="mt-1 text-xs text-muted-foreground">{selectedAgent.model || defaults.model} · last used {formatDate(selectedAgent.lastUsedAt)}</p></div>{selectedAgent.tokenId !== "codex-runtime" ? <Button variant="destructive" size="sm" disabled={busy} onClick={() => void deleteToken(selectedAgent.tokenId)}><Trash2 className="size-4" />Delete token</Button> : null}</div>
                </div>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="rounded-[16px] border border-border/70 bg-background/70 p-4"><div className="flex items-center gap-2 font-semibold"><MessageSquareText className="size-4 text-sky-500" />Sessions</div><div className="mt-3 space-y-2">{selectedAgent.sessionIds.slice(0, 6).map((id) => <div key={id} className="flex items-center justify-between gap-2"><span className="truncate text-sm">{sessionsById.get(id)?.title ?? "Untitled session"}</span><Button variant="outline" size="sm" onClick={() => void selectSession(id)}>Open</Button></div>)}</div></div>
                  <div className="rounded-[16px] border border-border/70 bg-background/70 p-4"><div className="flex items-center gap-2 font-semibold"><FolderKanban className="size-4 text-violet-500" />Projects</div><div className="mt-3 space-y-2">{selectedAgent.projectIds.slice(0, 6).map((id) => <div key={id} className="flex items-center justify-between gap-2"><span className="truncate text-sm">{projectsById.get(id)?.title ?? "Untitled project"}</span><Button variant="outline" size="sm" onClick={() => void selectProject(id)}>Open</Button></div>)}</div></div>
                </div>
                <div className="mt-4 rounded-[16px] border border-border/70 bg-background/70 p-4"><p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Recent events</p><div className="mt-3 space-y-2">{events.length === 0 ? <p className="text-sm text-muted-foreground">No events recorded yet.</p> : events.slice(0, 12).map((event) => <div key={event.id} className="rounded-[14px] border border-border/70 bg-card/70 px-3 py-2 text-sm"><div className="flex justify-between gap-2"><span className="font-medium">{event.eventType}</span><span className="text-xs text-muted-foreground">{formatDate(event.createdAt)}</span></div><p className="mt-1 text-xs text-muted-foreground">{event.method} {event.route}</p></div>)}</div></div>
              </>}
            </section>
          </div>
        </div></div>
      </div>
    </div>
  );
}
