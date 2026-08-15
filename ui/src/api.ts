/**
 * Typed client of the daemon's control API. Row and response types come
 * straight from the steerium workspace so the UI can't drift from the server.
 */
import type {
  AgentCallRecord,
  ApprovalListing,
  ArtifactInfo,
  DaemonInfo,
  FireResult,
  RunRecord,
  RunEventRecord,
  RunStepRecord,
  WorkflowSummary,
} from "steerium";

export type {
  AgentCallRecord,
  ApprovalListing,
  ArtifactInfo,
  DaemonInfo,
  FireResult,
  RunRecord,
  RunEventRecord,
  RunStepRecord,
  WorkflowSummary,
};

export interface RunDetail {
  run: RunRecord;
  steps: RunStepRecord[];
  agentCalls: AgentCallRecord[];
  events: RunEventRecord[];
}

export interface RunsQuery {
  limit?: number;
  offset?: number;
  workflow?: string;
  status?: string;
}

function qs(params: object): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params) as [string, string | number | undefined][]) {
    if (v !== undefined && v !== "") p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  status: () => request<DaemonInfo>("GET", "/status"),
  workflows: () => request<WorkflowSummary[]>("GET", "/workflows"),
  runs: (q: RunsQuery = {}) => request<RunRecord[]>("GET", `/runs${qs(q)}`),
  runsCount: (q: Pick<RunsQuery, "workflow" | "status"> = {}) =>
    request<{ total: number }>("GET", `/runs/count${qs(q)}`),
  run: (id: string) => request<RunDetail>("GET", `/runs/${encodeURIComponent(id)}`),
  runEvents: (id: string, after = 0) =>
    request<RunEventRecord[]>("GET", `/runs/${encodeURIComponent(id)}/events${qs({ after })}`),
  artifacts: (id: string) =>
    request<ArtifactInfo[]>("GET", `/runs/${encodeURIComponent(id)}/artifacts`),
  artifactUrl: (id: string, path: string) =>
    `/runs/${encodeURIComponent(id)}/artifacts/${path.split("/").map(encodeURIComponent).join("/")}`,
  fire: (name: string, input?: unknown) =>
    request<FireResult>("POST", `/run/${encodeURIComponent(name)}`, input ?? {}),
  replay: (runId: string) => request<FireResult>("POST", `/replay/${encodeURIComponent(runId)}`),
  cancel: (runId: string) =>
    request<{ cancelled: boolean }>("POST", `/runs/${encodeURIComponent(runId)}/cancel`),
  approvals: () => request<ApprovalListing[]>("GET", "/approvals"),
  respondApproval: (
    id: string,
    text: string,
    requestId: string,
    scopeId?: string,
  ) =>
    request<{ ok: boolean }>("POST", `/approvals/${encodeURIComponent(id)}/respond`, {
      text,
      requestId,
      scopeId,
    }),
};

/**
 * Subscribe to append-only run events, then refresh the requested projection.
 * EventSource resumes from its Last-Event-ID cursor automatically.
 */
export function subscribe(
  q: RunsQuery & { run?: string },
  onUpdate: (data: { runs: RunRecord[]; detail?: RunDetail | null }) => void,
  onStateChange?: (connected: boolean) => void,
): () => void {
  const es = new EventSource("/stream?after=latest");
  let refreshing = false;
  let pending = false;
  const { run, ...runsQuery } = q;
  const refresh = async () => {
    if (refreshing) {
      pending = true;
      return;
    }
    refreshing = true;
    try {
      const [runs, detail] = await Promise.all([
        api.runs(runsQuery),
        run ? api.run(run).catch(() => null) : Promise.resolve(undefined),
      ]);
      onUpdate({ runs, detail });
    } catch {
      onStateChange?.(false);
    } finally {
      refreshing = false;
      if (pending) {
        pending = false;
        void refresh();
      }
    }
  };
  es.addEventListener("run-event", () => {
    onStateChange?.(true);
    void refresh();
  });
  es.onopen = () => onStateChange?.(true);
  es.onerror = () => onStateChange?.(false);
  void refresh();
  return () => es.close();
}

export function formatDuration(start: number | null, end: number | null): string {
  if (!start) return "";
  const ms = (end ?? Date.now()) - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
