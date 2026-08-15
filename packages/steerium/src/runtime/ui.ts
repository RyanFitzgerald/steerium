/**
 * Optional browser UI. A single self-contained HTML
 * page served by the daemon at "/". It is a thin client of the same control API
 * the CLI uses — no build step, no framework, no editor. The core stays
 * dependency-light; the UI is never load-bearing.
 *
 * Behavior notes:
 *   - The runs list and any open run detail auto-refresh every 2.5s (paused
 *     while the tab is hidden), so long agent runs can be watched live.
 *   - "run now" / "replay" fire without blocking on run completion; the
 *     outcome (ok | error | dropped | skipped) lands in a toast when the run
 *     settles, and the running row appears via refresh in the meantime.
 *   - All dynamic values go through esc() (quotes included) and buttons use
 *     data-attributes + one delegated listener — no interpolated onclick.
 */
export const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>steerium</title>
<style>
  :root { color-scheme: light dark; --b: #8884; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; padding: 1.5rem; max-width: 1000px; }
  h1 { font-size: 1.2rem; margin: 0 0 1rem; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid var(--b); vertical-align: top; }
  th { opacity: .6; font-weight: 600; }
  button, input, select { font: inherit; padding: .15rem .5rem; border: 1px solid var(--b); border-radius: 4px; background: transparent; color: inherit; }
  button { cursor: pointer; }
  button:hover { background: #8882; }
  .ok { color: #2a8; } .error { color: #d44; } .running, .warn { color: #d92; }
  .muted { opacity: .55; }
  .row-actions { white-space: nowrap; }
  pre { background: #8881; padding: .75rem; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; margin: .25rem 0; }
  #detail { margin-top: 1rem; }
  #toast { position: fixed; top: 1rem; right: 1rem; max-width: 24rem; padding: .5rem .75rem; border: 1px solid var(--b); border-radius: 6px; background: Canvas; box-shadow: 0 2px 8px #0003; }
  #controls { display: inline-flex; gap: .5rem; margin-left: .5rem; vertical-align: middle; font-weight: 400; }
</style>
</head>
<body>
  <h1>steerium <span class="muted" id="conn"></span></h1>
  <div id="toast" hidden></div>

  <h2>Workflows</h2>
  <table><thead><tr><th>name</th><th>trigger</th><th>scope</th><th></th></tr></thead><tbody id="wfs"></tbody></table>

  <h2>Recent runs
    <span id="controls">
      <input id="filter" placeholder="filter…" size="14" />
      <select id="limit"><option>25</option><option>100</option><option>500</option></select>
      <span class="muted" id="tick">auto-refresh</span>
    </span>
  </h2>
  <table><thead><tr><th>when</th><th>status</th><th>workflow</th><th>trigger</th><th>duration</th><th>run</th><th></th></tr></thead><tbody id="runs"></tbody></table>

  <div id="detail"></div>

<script>
const api = (m, p, b) => fetch(p, { method: m, headers: b ? { "content-type": "application/json" } : {}, body: b ? JSON.stringify(b) : undefined }).then(r => r.json());
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cls = s => s === "ok" ? "ok" : (s === "queued" || s === "running") ? "running" : "error";
const dur = r => r.started_at && r.finished_at ? (r.finished_at - r.started_at) + "ms" : (r.status === "running" ? "…" : "");
const $ = id => document.getElementById(id);

let runsCache = [], detailId = null, lastDetail = "", toastTimer;

function toast(msg, kind) {
  const t = $("toast");
  t.hidden = false; t.textContent = msg; t.className = kind || "muted";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

async function loadWorkflows() {
  const wfs = await api("GET", "/workflows");
  $("wfs").innerHTML = wfs.map(w =>
    \`<tr><td>\${esc(w.name)}</td><td class="muted">\${esc(w.triggerKind)}</td><td class="muted">\${esc(w.scopeId)}</td>
     <td class="row-actions"><button data-act="run" data-arg="\${esc(w.name)}">run now</button></td></tr>\`).join("");
}

async function loadRuns() {
  runsCache = await api("GET", "/runs?limit=" + $("limit").value);
  renderRuns();
}

function renderRuns() {
  const q = $("filter").value.trim().toLowerCase();
  const rows = runsCache.filter(r => !q ||
    r.workflow_name.toLowerCase().includes(q) || r.status.includes(q) ||
    (r.trigger_kind || "").toLowerCase().includes(q) || r.id.startsWith(q));
  $("runs").innerHTML = rows.map(r =>
    \`<tr><td class="muted">\${new Date(r.created_at).toLocaleString()}</td>
     <td class="\${cls(r.status)}">\${esc(r.status)}</td>
     <td>\${esc(r.workflow_name)}</td><td class="muted">\${esc(r.trigger_kind || "")}</td>
     <td class="muted">\${dur(r)}</td>
     <td class="muted" title="\${esc(r.id)}">\${esc(r.id.slice(0, 8))}</td>
     <td class="row-actions"><button data-act="view" data-arg="\${esc(r.id)}">view</button>
     <button data-act="replay" data-arg="\${esc(r.id)}">replay</button></td></tr>\`).join("");
}

/** Fire without blocking on run completion; report the outcome when it lands. */
function fire(path, label) {
  toast(label + "…", "muted");
  api("POST", path, {}).then(res => {
    const kind = res.status === "ok" ? "ok" : "error";
    const id = res.runId ? " (" + res.runId.slice(0, 8) + ")" : "";
    toast(label + ": " + res.status + (res.error ? " — " + res.error : "") + id, kind);
    loadRuns();
  }).catch(err => toast(label + ": " + err, "error"));
  setTimeout(loadRuns, 300); // pick up the 'running' row while it executes
}

async function showRun(id, scroll) {
  detailId = id;
  const res = await api("GET", "/runs/" + encodeURIComponent(id));
  if (!res || !res.run) { toast("run " + id.slice(0, 8) + " not found", "error"); return; }
  const key = JSON.stringify(res);
  if (key === lastDetail && !scroll) return; // avoid re-render flicker on refresh
  lastDetail = key;
  const { run, steps } = res;
  const stepHtml = steps.map(s =>
    \`<tr><td>\${esc(s.name)}</td><td class="\${cls(s.status)}">\${esc(s.status)}</td>
     <td class="muted">\${dur(s)}</td>
     <td><pre>\${esc(s.error || (s.output_json && s.output_json !== "null" ? s.output_json : ""))}</pre></td></tr>\`).join("");
  $("detail").innerHTML =
    \`<h2>Run \${esc(run.id)} <span class="muted">\${esc(run.workflow_name)} · \${dur(run)}</span></h2>
     <p class="\${cls(run.status)}">\${esc(run.status)}\${run.error ? " — " + esc(run.error) : ""}</p>
     <table><thead><tr><th>step</th><th>status</th><th>duration</th><th>output / error</th></tr></thead><tbody>\${stepHtml}</tbody></table>
     <h2>Event</h2><pre>\${esc(run.event_json)}</pre>\`;
  if (scroll) $("detail").scrollIntoView({ behavior: "smooth" });
}

document.addEventListener("click", e => {
  const b = e.target.closest("button[data-act]");
  if (!b) return;
  const arg = b.dataset.arg;
  if (b.dataset.act === "run") fire("/run/" + encodeURIComponent(arg), "run " + arg);
  if (b.dataset.act === "replay") fire("/replay/" + encodeURIComponent(arg), "replay " + arg.slice(0, 8));
  if (b.dataset.act === "view") showRun(arg, true);
});
$("filter").addEventListener("input", renderRuns);
$("limit").addEventListener("change", loadRuns);

async function tick() {
  if (document.hidden) return;
  try {
    await loadRuns();
    if (detailId) await showRun(detailId, false);
    $("conn").textContent = "· connected";
  } catch {
    $("conn").textContent = "· offline";
  }
}

loadWorkflows();
tick();
setInterval(tick, 2500);
</script>
</body>
</html>`;
