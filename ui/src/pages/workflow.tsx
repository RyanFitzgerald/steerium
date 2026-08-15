import { useEffect, useState } from "preact/hooks";
import { api, subscribe, type RunRecord, type WorkflowSummary } from "../api";
import { reportFire, RunsTable } from "../components";
import { toast } from "../toast";

export function Workflow({ name }: { name: string }) {
  const [wf, setWf] = useState<WorkflowSummary | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [input, setInput] = useState("");

  useEffect(() => {
    api
      .workflows()
      .then((all) => setWf(all.find((w) => w.name === name) ?? null))
      .catch(() => setWf(null));
    return subscribe({ workflow: name, limit: 50 }, (data) => setRuns(data.runs));
  }, [name]);

  const fire = () => {
    let payload: unknown;
    if (input.trim()) {
      try {
        payload = JSON.parse(input);
      } catch {
        toast("input is not valid JSON", "error");
        return;
      }
    }
    reportFire(`run ${name}`, api.fire(name, payload));
  };

  return (
    <>
      <h2>
        <a href="#/workflows" class="muted">
          workflows /
        </a>{" "}
        {name}
      </h2>
      {wf ? (
        <dl class="kv">
          <dt>trigger</dt>
          <dd>{wf.triggerKind}</dd>
          <dt>scope</dt>
          <dd>{wf.scopeId}</dd>
          {wf.tags?.length ? (
            <>
              <dt>tags</dt>
              <dd>{wf.tags.join(", ")}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p class="muted">not loaded by the running daemon</p>
      )}

      <h2>Fire manually</h2>
      <textarea
        class="input-json"
        placeholder='optional JSON input — arrives as ctx.event.input, e.g. {"url": "https://…"}'
        value={input}
        onInput={(e) => setInput(e.currentTarget.value)}
      />
      <div class="controls" style="margin-top:0.5rem">
        <button type="button" class="primary" onClick={fire}>
          run now
        </button>
      </div>

      <h2>Runs</h2>
      <RunsTable runs={runs} showWorkflow={false} />
    </>
  );
}
