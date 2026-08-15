import { api, formatDuration, type FireResult, type RunRecord } from "./api";
import { toast } from "./toast";

export function StatusBadge({ status }: { status: string }) {
  const cls = ["ok", "resolved"].includes(status)
    ? "ok"
    : ["queued", "running", "pending"].includes(status)
      ? "running"
      : "error";
  return <span class={`badge ${cls}`}>{status}</span>;
}

export function reportFire(label: string, p: Promise<FireResult>): void {
  toast(`${label}…`);
  p.then((res) => {
    const kind = res.status === "ok" ? "ok" : res.status === "queued" ? "info" : "error";
    const id = res.runId ? ` (${res.runId.slice(0, 8)})` : "";
    toast(`${label}: ${res.status}${res.error ? ` — ${res.error}` : ""}${id}`, kind);
  }).catch((err: Error) => toast(`${label}: ${err.message}`, "error"));
}

export function RunsTable({
  runs,
  showWorkflow = true,
}: {
  runs: RunRecord[];
  showWorkflow?: boolean;
}) {
  if (!runs.length) return <div class="empty">no runs yet</div>;
  return (
    <table>
      <thead>
        <tr>
          <th>when</th>
          <th>status</th>
          {showWorkflow && <th>workflow</th>}
          <th>trigger</th>
          <th>duration</th>
          <th>run</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} class="click" onClick={() => (location.hash = `#/runs/${r.id}`)}>
            <td class="muted">{new Date(r.created_at).toLocaleString()}</td>
            <td>
              <StatusBadge status={r.status} />
            </td>
            {showWorkflow && <td>{r.workflow_name}</td>}
            <td class="muted">{r.trigger_kind ?? ""}</td>
            <td class="muted">
              {r.status === "queued" ? "waiting" : r.status === "running" ? "…" : formatDuration(r.started_at, r.finished_at)}
            </td>
            <td class="muted" title={r.id}>
              {r.id.slice(0, 8)}
            </td>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: this cell is not a control — it only cancels the row click so the buttons inside it work; keyboard users reach those buttons directly. */}
            <td onClick={(e) => e.stopPropagation()}>
              <span class="row-actions">
                {r.status === "running" ? (
                  <button type="button"
                    class="danger"
                    onClick={() =>
                      api
                        .cancel(r.id)
                        .then(() => toast(`cancelled ${r.id.slice(0, 8)}`, "ok"))
                        .catch((err: Error) => toast(`cancel: ${err.message}`, "error"))
                    }
                  >
                    cancel
                  </button>
                ) : (
                  <button type="button" onClick={() => reportFire(`replay ${r.id.slice(0, 8)}`, api.replay(r.id))}>
                    replay
                  </button>
                )}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
