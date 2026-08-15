import { useEffect, useState } from "preact/hooks";
import { api, type WorkflowSummary } from "../api";
import { reportFire } from "../components";

export function Workflows() {
  const [wfs, setWfs] = useState<WorkflowSummary[] | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    api.workflows().then(setWfs).catch(() => setWfs([]));
  }, []);

  if (!wfs) return <div class="empty">loading…</div>;
  const query = q.trim().toLowerCase();
  const filtered = wfs.filter(
    (w) =>
      !query ||
      w.name.toLowerCase().includes(query) ||
      w.triggerKind.toLowerCase().includes(query) ||
      w.scopeId.toLowerCase().includes(query) ||
      (w.tags ?? []).some((t) => t.toLowerCase().includes(query)),
  );

  return (
    <>
      <div class="controls">
        <h2 style="margin:0">Workflows</h2>
        <span class="spacer" />
        <input placeholder="filter…" value={q} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      {filtered.length ? (
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>trigger</th>
              <th>scope</th>
              <th>tags</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((w) => (
              <tr
                key={`${w.scopeId}:${w.name}`}
                class="click"
                onClick={() => (location.hash = `#/workflows/${encodeURIComponent(w.name)}`)}
              >
                <td>{w.name}</td>
                <td class="muted">{w.triggerKind}</td>
                <td class="muted">{w.scopeId}</td>
                <td class="muted">{(w.tags ?? []).join(", ")}</td>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: this cell is not a control — it only cancels the row click so the buttons inside it work; keyboard users reach those buttons directly. */}
                <td onClick={(e) => e.stopPropagation()}>
                  <button type="button" onClick={() => reportFire(`run ${w.name}`, api.fire(w.name))}>
                    run now
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div class="empty">no workflows{query ? " match the filter" : " loaded"}</div>
      )}
    </>
  );
}
