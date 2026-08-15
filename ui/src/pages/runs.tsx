import { useEffect, useMemo, useState } from "preact/hooks";
import { api, subscribe, type RunRecord, type WorkflowSummary } from "../api";
import { RunsTable } from "../components";

const LIMITS = [25, 100, 500];

export function Runs() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflow, setWorkflow] = useState("");
  const [status, setStatus] = useState("");
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);

  useEffect(() => {
    api.workflows().then(setWorkflows).catch(() => setWorkflows([]));
  }, []);

  // Reset paging whenever the filter changes.
  useEffect(() => setOffset(0), [workflow, status, limit]);

  useEffect(() => {
    api
      .runsCount({ workflow: workflow || undefined, status: status || undefined })
      .then((c) => setTotal(c.total))
      .catch(() => setTotal(null));
    return subscribe(
      {
        limit,
        offset,
        workflow: workflow || undefined,
        status: status || undefined,
      },
      (data) => setRuns(data.runs),
    );
  }, [workflow, status, limit, offset]);

  const names = useMemo(
    () => [...new Set(workflows.map((w) => w.name))].sort(),
    [workflows],
  );

  return (
    <>
      <div class="controls">
        <h2 style="margin:0">Runs {total !== null && <span class="muted">({total})</span>}</h2>
        <span class="spacer" />
        <select value={workflow} onChange={(e) => setWorkflow(e.currentTarget.value)}>
          <option value="">all workflows</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.currentTarget.value)}>
          <option value="">any status</option>
          <option value="ok">ok</option>
          <option value="failed">failed</option>
          <option value="cancelled">cancelled</option>
          <option value="timed_out">timed out</option>
          <option value="interrupted">interrupted</option>
          <option value="dropped">dropped</option>
          <option value="queued">queued</option>
          <option value="running">running</option>
        </select>
        <select value={String(limit)} onChange={(e) => setLimit(Number(e.currentTarget.value))}>
          {LIMITS.map((l) => (
            <option key={l} value={String(l)}>
              {l} / page
            </option>
          ))}
        </select>
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
          ‹ prev
        </button>
        <button type="button"
          disabled={total !== null ? offset + limit >= total : runs.length < limit}
          onClick={() => setOffset(offset + limit)}
        >
          next ›
        </button>
      </div>
      <RunsTable runs={runs} />
    </>
  );
}
