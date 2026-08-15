import { useEffect, useState } from "preact/hooks";
import { api, formatDuration, subscribe, type DaemonInfo, type RunRecord } from "../api";
import { RunsTable } from "../components";

export function Dashboard() {
  const [info, setInfo] = useState<DaemonInfo | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [counts, setCounts] = useState<{ ok: number; failed: number; running: number } | null>(null);

  useEffect(() => {
    api.status().then(setInfo).catch(() => setInfo(null));
    const refreshCounts = () =>
      Promise.all([
        api.runsCount({ status: "ok" }),
        ...["failed", "cancelled", "timed_out", "interrupted", "dropped"].map((status) =>
          api.runsCount({ status }),
        ),
        api.runsCount({ status: "running" }),
      ])
        .then(([ok, ...rest]) =>
          setCounts({
            ok: ok.total,
            failed: rest.slice(0, -1).reduce((sum, count) => sum + count.total, 0),
            running: rest.at(-1)?.total ?? 0,
          }),
        )
        .catch(() => setCounts(null));
    refreshCounts();
    return subscribe({ limit: 10 }, (data) => {
      setRuns(data.runs);
      refreshCounts();
    });
  }, []);

  return (
    <>
      <h2>Daemon</h2>
      {info ? (
        <div class="cards">
          <div class="card">
            <div class="n">{info.workflows}</div>
            <div class="l">workflows loaded</div>
          </div>
          <div class="card">
            <div class="n ok">{counts?.ok ?? "–"}</div>
            <div class="l">runs ok</div>
          </div>
          <div class="card">
            <div class="n error">{counts?.failed ?? "–"}</div>
            <div class="l">runs failed</div>
          </div>
          <div class="card">
            <div class="n running">{counts?.running ?? "–"}</div>
            <div class="l">running now</div>
          </div>
          <div class="card">
            <div class="n">{formatDuration(info.startedAt, null)}</div>
            <div class="l">
              uptime — pid {info.pid}, {info.mode} scope
            </div>
          </div>
        </div>
      ) : (
        <div class="empty">daemon status unavailable</div>
      )}

      {info && info.mode === "global" && (
        <>
          <h2>Projects</h2>
          {info.projects.length ? (
            <table>
              <thead>
                <tr>
                  <th>root</th>
                  <th>state</th>
                  <th>workflows</th>
                </tr>
              </thead>
              <tbody>
                {info.projects.map((p) => (
                  <tr key={p.root}>
                    <td>{p.root}</td>
                    <td>
                      {p.exists ? (
                        <span class="ok">loaded</span>
                      ) : (
                        <span class="error">path missing</span>
                      )}
                    </td>
                    <td class="muted">{p.workflows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div class="empty">
              no registered projects — <code>steerium project add &lt;path&gt;</code>
            </div>
          )}
        </>
      )}

      <h2>
        Recent runs <a href="#/runs" class="muted" style="font-weight:400">— see all</a>
      </h2>
      <RunsTable runs={runs} />
    </>
  );
}
