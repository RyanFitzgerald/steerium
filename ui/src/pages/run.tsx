import { useEffect, useState } from "preact/hooks";
import {
  api,
  formatDuration,
  formatSize,
  formatTokens,
  subscribe,
  type AgentCallRecord,
  type ArtifactInfo,
  type RunDetail,
  type RunStepRecord,
} from "../api";
import { reportFire, StatusBadge } from "../components";
import { toast } from "../toast";

/**
 * Sum one set of agent calls. Token fields are disjoint (input excludes cache
 * reads/writes), so `total` — the sum of all four — matches the ccusage
 * totalTokens convention. Calls whose provider reported no usage count as
 * `unknown`, never as zero.
 */
function sumCalls(calls: AgentCallRecord[]) {
  const t = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, known: 0, unknown: 0, total: 0 };
  for (const c of calls) {
    const reported =
      c.input_tokens !== null ||
      c.output_tokens !== null ||
      c.cache_read_tokens !== null ||
      c.cache_creation_tokens !== null;
    if (!reported) {
      t.unknown++;
      continue;
    }
    t.known++;
    t.input += c.input_tokens ?? 0;
    t.output += c.output_tokens ?? 0;
    t.cacheRead += c.cache_read_tokens ?? 0;
    t.cacheCreation += c.cache_creation_tokens ?? 0;
  }
  t.total = t.input + t.output + t.cacheRead + t.cacheCreation;
  return t;
}

/** Inline badge for a step's agent calls; null for deterministic steps. */
function AgentBadge({ calls }: { calls: AgentCallRecord[] }) {
  if (!calls.length) return null;
  const providers = [...new Set(calls.map((c) => c.provider))].join(",");
  const t = sumCalls(calls);
  const label =
    t.known > 0
      ? `agent · ${providers} · ${formatTokens(t.total)} tok${
          t.unknown > 0 ? ` (+${t.unknown} unknown)` : ""
        }`
      : `agent · ${providers} · usage unknown`;
  return <span class="muted">{label}</span>;
}

function Step({ step, calls }: { step: RunStepRecord; calls: AgentCallRecord[] }) {
  const output =
    step.output_json && step.output_json !== "null"
      ? (() => {
          try {
            return JSON.stringify(JSON.parse(step.output_json!), null, 2);
          } catch {
            return step.output_json;
          }
        })()
      : null;
  return (
    <details class="step" open={step.status !== "ok"}>
      <summary>
        <StatusBadge status={step.status} />
        <strong>{step.name}</strong>
        <span class="muted">
          {step.status === "running" ? "…" : formatDuration(step.started_at, step.finished_at)}
        </span>
        <AgentBadge calls={calls} />
      </summary>
      <div class="body">
        {step.error && <pre class="error">{step.error}</pre>}
        {output && <pre>{output}</pre>}
        {step.logs && (
          <details>
            <summary class="muted">logs</summary>
            <pre>{step.logs}</pre>
          </details>
        )}
        {!step.error && !output && !step.logs && <p class="muted">no output</p>}
      </div>
    </details>
  );
}

export function Run({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const loadArtifacts = () => api.artifacts(id).then(setArtifacts).catch(() => setArtifacts([]));
    api
      .run(id)
      .then((d) => {
        setDetail(d);
        loadArtifacts();
      })
      .catch(() => setMissing(true));
    // Live-update the detail while the run executes; refresh artifacts when
    // the status flips (steps usually write them just before finishing).
    return subscribe({ limit: 1, run: id }, (data) => {
      if (data.detail) {
        setDetail((prev) => {
          if (prev && prev.run.status !== data.detail!.run.status) loadArtifacts();
          return data.detail!;
        });
      }
    });
  }, [id]);

  if (missing) return <div class="empty">run {id.slice(0, 8)} not found</div>;
  if (!detail) return <div class="empty">loading…</div>;
  const { run, steps } = detail;
  const agentCalls = detail.agentCalls ?? [];
  const callsByStep = new Map<string, AgentCallRecord[]>();
  for (const c of agentCalls) {
    if (!c.step_id) continue;
    const list = callsByStep.get(c.step_id) ?? [];
    list.push(c);
    callsByStep.set(c.step_id, list);
  }
  const totals = sumCalls(agentCalls);
  const provenance = (() => {
    try {
      return run.provenance_json ? JSON.parse(run.provenance_json) as Record<string, unknown> : null;
    } catch {
      return null;
    }
  })();

  const event = (() => {
    try {
      return JSON.stringify(JSON.parse(run.event_json), null, 2);
    } catch {
      return run.event_json;
    }
  })();

  return (
    <>
      <h2>
        <a href="#/runs" class="muted">
          runs /
        </a>{" "}
        {run.id.slice(0, 8)} <StatusBadge status={run.status} />
      </h2>
      <dl class="kv">
        <dt>workflow</dt>
        <dd>
          <a href={`#/workflows/${encodeURIComponent(run.workflow_name)}`}>{run.workflow_name}</a>
        </dd>
        <dt>run id</dt>
        <dd>{run.id}</dd>
        <dt>scope</dt>
        <dd>{run.scope_id}</dd>
        <dt>trigger</dt>
        <dd>{run.trigger_kind ?? "—"}</dd>
        <dt>started</dt>
        <dd>{run.started_at ? new Date(run.started_at).toLocaleString() : "—"}</dd>
        <dt>duration</dt>
        <dd>{run.status === "queued" ? "waiting" : run.status === "running" ? "…" : formatDuration(run.started_at, run.finished_at)}</dd>
        {provenance && (
          <>
            <dt>runtime</dt>
            <dd>Steerium {String(provenance.steeriumVersion)} · Node {String(provenance.nodeVersion)}</dd>
            <dt>workflow hash</dt>
            <dd title={String(provenance.workflowHash)}>{String(provenance.workflowHash).slice(0, 12)}</dd>
            {provenance.git && typeof provenance.git === "object" ? (
              <>
                <dt>git</dt>
                <dd>{String((provenance.git as { sha: string }).sha).slice(0, 12)}{(provenance.git as { dirty: boolean }).dirty ? " (dirty)" : ""}</dd>
              </>
            ) : null}
          </>
        )}
        {agentCalls.length > 0 && (
          <>
            <dt>agent calls</dt>
            <dd>
              {agentCalls.length} · {steps.length - callsByStep.size} of {steps.length} steps
              deterministic
            </dd>
            <dt>tokens</dt>
            <dd>
              {totals.known > 0 ? (
                <>
                  {formatTokens(totals.total)} total{" "}
                  <span class="muted">
                    ({formatTokens(totals.input)} in / {formatTokens(totals.output)} out /{" "}
                    {formatTokens(totals.cacheRead)} cache-read / {formatTokens(totals.cacheCreation)}{" "}
                    cache-write
                    {totals.unknown > 0 ? ` · ${totals.unknown} calls usage unknown` : ""})
                  </span>
                </>
              ) : (
                <span class="muted">unknown (provider did not report usage)</span>
              )}
            </dd>
          </>
        )}
      </dl>
      {run.error && <pre class="error">{run.error_code ? `[${run.error_code}] ` : ""}{run.error}</pre>}

      <div class="controls" style="margin-top:0.75rem">
        {run.status === "running" ? (
          <button type="button"
            class="danger"
            onClick={() =>
              api
                .cancel(run.id)
                .then(() => toast("cancel requested", "ok"))
                .catch((err: Error) => toast(`cancel: ${err.message}`, "error"))
            }
          >
            cancel run
          </button>
        ) : (
          <button type="button" onClick={() => reportFire(`replay ${run.id.slice(0, 8)}`, api.replay(run.id))}>
            replay against same event
          </button>
        )}
      </div>

      <h2>Steps</h2>
      {steps.length ? (
        steps.map((s) => <Step key={s.id} step={s} calls={callsByStep.get(s.id) ?? []} />)
      ) : (
        <div class="empty">no steps recorded</div>
      )}

      <h2>Artifacts</h2>
      {artifacts.length ? (
        <table>
          <thead>
            <tr>
              <th>file</th>
              <th>size</th>
              <th>modified</th>
            </tr>
          </thead>
          <tbody>
            {artifacts.map((a) => (
              <tr key={a.path}>
                <td>
                  <a href={api.artifactUrl(run.id, a.path)} target="_blank" rel="noreferrer">
                    {a.path}
                  </a>
                </td>
                <td class="muted">{formatSize(a.size)}</td>
                <td class="muted">{new Date(a.mtime).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div class="empty">no artifacts</div>
      )}

      <h2>Event</h2>
      <pre>{event}</pre>

      <h2>Timeline</h2>
      {detail.events?.length ? (
        <table>
          <thead><tr><th>time</th><th>type</th><th>data</th></tr></thead>
          <tbody>
            {detail.events.map((item) => (
              <tr key={item.id}>
                <td class="muted">{new Date(item.created_at).toLocaleTimeString()}</td>
                <td>{item.type}</td>
                <td><code>{item.data_json}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <div class="empty">no timeline events</div>}
    </>
  );
}
