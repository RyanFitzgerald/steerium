import { strict as assert } from "node:assert";
import { test } from "node:test";
import { openSqliteStore } from "../src/store/store.js";

test("run lifecycle persists status, event, and steps", async () => {
  const store = await openSqliteStore(":memory:");
  const event = {
    source: "linear",
    type: "ticketMoved",
    ticket: { id: "T-1", status: "Todo" },
  };

  store.createRun({
    id: "run1",
    scope_id: "global",
    workflow_name: "wf",
    trigger_kind: "manual",
    event_json: JSON.stringify(event),
  });
  assert.equal(store.getRun("run1")?.status, "queued");
  const observed: number[] = [];
  const unsubscribe = store.subscribeRunEvents((item) => observed.push(item.seq));
  store.appendRunEvent("run1", "run.queued", { workflow: "wf" }, 999);
  store.startRun("run1", 1000);
  store.startStep({ id: "s1", run_id: "run1", name: "plan" }, 1001);
  store.finishStep("s1", "ok", 1002, JSON.stringify({ text: "hi" }), undefined, "log line");
  store.finishRun("run1", "ok", 1003);

  const run = store.getRun("run1");
  assert.ok(run);
  assert.equal(run!.status, "ok");
  // The stored event enables replay (§12.7).
  assert.deepEqual(JSON.parse(run!.event_json), event);

  const steps = store.listSteps("run1");
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.name, "plan");
  assert.equal(steps[0]!.status, "ok");

  const runs = store.listRuns({ limit: 10 });
  assert.equal(runs.length, 1);
  const events = store.listRunEvents({ runId: "run1" });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "run.queued");
  assert.deepEqual(observed, [events[0]!.seq]);
  assert.equal(store.latestRunEventSeq(), events[0]!.seq);
  unsubscribe();
  store.close();
});

test("event dedupe lookup works", async () => {
  const store = await openSqliteStore(":memory:");
  store.insertEvent(
    {
      id: "e1",
      source: "linear",
      type: "ticketMoved",
      scope_id: "global",
      workflow_name: "wf",
      dedupe_key: "linear:T-1:Todo",
      payload_json: "{}",
      raw_json: null,
      occurred_at: null,
    },
    Date.now(),
  );
  assert.ok(store.findEventByDedupe("linear:T-1:Todo"));
  assert.equal(store.findEventByDedupe("linear:T-2:Todo"), undefined);
  store.close();
});

test("scoped dedupe distinguishes workflows so multiple listeners both fire", async () => {
  const store = await openSqliteStore(":memory:");
  const base = {
    source: "linear",
    type: "ticketMoved",
    dedupe_key: "linear:T-1:Todo",
    payload_json: "{}",
    raw_json: null,
    occurred_at: null,
  };
  // Workflow A has seen this ticket.
  store.insertEvent({ id: "e1", scope_id: "global", workflow_name: "A", ...base }, Date.now());

  // A is deduped, but B (a different workflow) is not.
  assert.ok(store.findEventByDedupeScoped("linear:T-1:Todo", "global", "A"));
  assert.equal(store.findEventByDedupeScoped("linear:T-1:Todo", "global", "B"), undefined);
  store.close();
});

test("kv round-trips JSON values", async () => {
  const store = await openSqliteStore(":memory:");
  store.kvSet("ns", "cursor", ["a", "b"]);
  assert.deepEqual(store.kvGet("ns", "cursor"), ["a", "b"]);
  store.kvDelete("ns", "cursor");
  assert.equal(store.kvGet("ns", "cursor"), undefined);
  store.close();
});

test("kvList enumerates one namespace only, in key order", async () => {
  const store = await openSqliteStore(":memory:");
  store.kvSet("a", "k2", 2);
  store.kvSet("a", "k1", 1);
  store.kvSet("b", "k3", 3);
  assert.deepEqual(store.kvList("a"), [
    { key: "k1", value: 1 },
    { key: "k2", value: 2 },
  ]);
  assert.deepEqual(store.kvList("missing"), []);
  store.close();
});
