import { strict as assert } from "node:assert";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Daemon } from "../src/runtime/daemon.js";
import { openSqliteStore } from "../src/store/store.js";
import {
  freshHome,
  freshProject,
  newDaemon,
  writeProjectWorkflow,
  writeWorkflow,
} from "./helpers.js";

test("manual fire records an events row and a run (every run has its event)", async () => {
  const home = freshHome();
  writeWorkflow(
    home,
    "t",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "t", on: manual(),
       async run(ctx) { await ctx.step("s", () => ctx.agent.run({ prompt: "hi" })); } });`,
  );
  const d = await newDaemon();
  const res = await d.fire("t", { source: "manual", foo: 1 });
  assert.equal(res.status, "ok");

  const store = d.getStore();
  const events = store.listEvents({ workflow: "t" });
  assert.equal(events.length, 1, "manual fire should persist one event");
  assert.equal(events[0]!.source, "manual");
  const run = store.getRun(res.runId)!;
  const provenance = JSON.parse(run.provenance_json!) as {
    steeriumVersion: string;
    nodeVersion: string;
    workflowHash: string;
    configFingerprint: string;
  };
  assert.ok(provenance.steeriumVersion);
  assert.match(provenance.nodeVersion, /^v/);
  assert.match(provenance.workflowHash, /^[a-f0-9]{64}$/);
  assert.match(provenance.configFingerprint, /^[a-f0-9]{64}$/);
  const types = store.listRunEvents({ runId: res.runId }).map((item) => item.type);
  assert.deepEqual(types, [
    "run.queued",
    "run.started",
    "step.started",
    "agent.started",
    "agent.completed",
    "step.completed",
    "run.completed",
  ]);
  await d.shutdown();
});

test("project config overrides the default provider for project-scoped runs", async () => {
  // Global default provider is mock; the project overrides it to a custom one.
  const proj = freshProject({
    config: `import { defineConfig, defineProvider } from "steerium";
     const tag = defineProvider({ name: "tag", async run(o) { return { text: "PROJECT:" + o.prompt }; } });
     export default defineConfig({ defaults: { provider: "tag" }, providers: { tag } });`,
  });
  const home = freshHome({
    config: `import { defineConfig } from "steerium";
     export default defineConfig({ defaults: { provider: "mock" }, projects: ${JSON.stringify([proj])} });`,
  });
  writeProjectWorkflow(
    proj,
    "p",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "p", on: manual(),
       async run(ctx) { const r = await ctx.agent.run({ prompt: "x" }); await ctx.artifact.writeText("o.txt", r.text); } });`,
  );

  const d = await newDaemon();
  const res = await d.fire("p", { source: "manual" }, proj);
  assert.equal(res.status, "ok", res.error);

  // The project's custom provider (not the global mock) handled the call.
  const out = readFileSync(join(home, "artifacts", res.runId, "o.txt"), "utf8");
  assert.equal(out, "PROJECT:x");
  await d.shutdown();
});

test("manual --input arrives as ctx.event.input (as the ManualEvent type promises)", async () => {
  const home = freshHome();
  writeWorkflow(
    home,
    "echo",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "echo", on: manual(),
       async run(ctx) {
         const input = (ctx.event.input ?? {});
         await ctx.artifact.writeText("in.json", JSON.stringify(input));
       } });`,
  );
  const d = await newDaemon();
  const res = await d.fire("echo", { url: "https://example.com" });
  assert.equal(res.status, "ok");
  const got = readFileSync(join(home, "artifacts", res.runId, "in.json"), "utf8");
  assert.deepEqual(JSON.parse(got), { url: "https://example.com" });
  await d.shutdown();
});

test("events over the concurrency limit queue and run when a slot frees", async () => {
  const home = freshHome();
  writeWorkflow(
    home,
    "q",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "q", on: manual(), concurrency: 1,
       async run() { await new Promise((r) => setTimeout(r, 80)); } });`,
  );
  const d = await newDaemon();
  const [a, b] = await Promise.all([
    d.fire("q", { source: "manual" }),
    d.fire("q", { source: "manual" }),
  ]);
  assert.equal(a.status, "ok");
  assert.equal(b.status, "ok", "second event should queue, not drop");
  assert.notEqual(a.runId, b.runId);

  const runs = d.getStore().listRuns({ workflow: "q" });
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === "ok"));
  await d.shutdown();
});

test("queue: 0 restores drop-on-overlap behavior", async () => {
  const home = freshHome();
  writeWorkflow(
    home,
    "nq",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "nq", on: manual(), concurrency: 1, queue: 0,
       async run() { await new Promise((r) => setTimeout(r, 80)); } });`,
  );
  const d = await newDaemon();
  const [a, b] = await Promise.all([
    d.fire("nq", { source: "manual" }),
    d.fire("nq", { source: "manual" }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ["dropped", "ok"]);
  const dropped = d.getStore().getRun(a.status === "dropped" ? a.runId : b.runId)!;
  assert.equal(dropped.status, "dropped");
  assert.deepEqual(
    d.getStore().listRunEvents({ runId: dropped.id }).map((item) => item.type),
    ["run.queued", "run.completed"],
  );
  await d.shutdown();
});

test("daemon startup recovers runs orphaned as 'running' by a crash", async () => {
  const home = freshHome();
  // Simulate a crash: a run row left in status 'running' by a dead process.
  const s = await openSqliteStore(join(home, "state.db"));
  s.createRun({
    id: "orphan",
    scope_id: "global",
    workflow_name: "ghost",
    trigger_kind: "manual",
    event_json: "null",
  });
  s.startStep({ id: "orphan-step", run_id: "orphan", name: "s" }, Date.now());
  s.close();

  // A real daemon (triggers enabled) owns execution and recovers on init.
  const d = new Daemon();
  await d.init();
  const run = d.getStore().getRun("orphan");
  assert.equal(run?.status, "interrupted");
  assert.match(run?.error ?? "", /interrupted/);
  const steps = d.getStore().listSteps("orphan");
  assert.equal(steps[0]?.status, "interrupted");
  await d.shutdown();
});

test("project-scoped daemon loads only that project's workflows", async () => {
  const home = freshHome();
  writeWorkflow(
    home,
    "g",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "g", on: manual(), async run() {} });`,
  );
  const proj = freshProject();
  writeProjectWorkflow(
    proj,
    "only",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "only", on: manual(),
       async run(ctx) { await ctx.artifact.writeText("cwd.txt", ctx.scope.cwd); } });`,
  );

  const d = await newDaemon({ projectRoot: proj });
  const names = d.listWorkflowSummaries().map((w) => w.name);
  assert.deepEqual(names, ["only"], "global workflows must not load in project mode");

  const res = await d.fire("only", { source: "manual" });
  assert.equal(res.status, "ok", res.error);
  const cwd = readFileSync(join(home, "artifacts", res.runId, "cwd.txt"), "utf8");
  assert.equal(
    realpathSync(cwd),
    realpathSync(proj),
    "project workflow must run with cwd = project root",
  );
  await d.shutdown();
});

test("a run that exceeds its timeout is marked timed_out", async () => {
  const home = freshHome();
  writeWorkflow(
    home,
    "slow",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "slow", on: manual(), timeoutMs: 50,
       async run() { await new Promise((r) => setTimeout(r, 400)); } });`,
  );
  const d = await newDaemon();
  const res = await d.fire("slow", { source: "manual" });
  assert.equal(res.status, "timed_out");
  assert.match(res.error ?? "", /timeoutMs/);
  await d.shutdown();
});
