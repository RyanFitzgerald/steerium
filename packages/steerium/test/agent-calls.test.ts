import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";
import {
  anthropicUsage,
  claudeJsonUsage,
  claudeResultError,
  claudeSdkUsage,
  codexUsage,
  openaiUsage,
} from "../src/providers/usage.js";
import { openSqliteStore } from "../src/store/store.js";
import { freshHome, newDaemon, tempDir, writeWorkflow } from "./helpers.js";

// ---- store ------------------------------------------------------------------

test("agent_calls round-trip: usage-reporting and usage-unknown rows", async () => {
  const store = await openSqliteStore(":memory:");
  store.createRun({
    id: "run1",
    scope_id: "global",
    workflow_name: "wf",
    trigger_kind: "manual",
    event_json: "{}",
  });
  store.recordAgentCall({
    id: "c1",
    run_id: "run1",
    step_id: "s1",
    provider: "anthropic",
    model: "claude-opus-5",
    status: "ok",
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 300,
    cache_creation_tokens: 5,
    cost_usd: null,
    started_at: 1000,
    finished_at: 1500,
    error: null,
  });
  store.recordAgentCall({
    id: "c2",
    run_id: "run1",
    step_id: null,
    provider: "custom",
    model: null,
    status: "ok",
    input_tokens: null, // provider reported nothing — unknown, not zero
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    cost_usd: null,
    started_at: 1600,
    finished_at: 1700,
    error: null,
  });

  const calls = store.listAgentCalls("run1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.id, "c1"); // ordered by started_at
  assert.equal(calls[0]!.cache_read_tokens, 300);
  assert.equal(calls[1]!.step_id, null);
  assert.equal(calls[1]!.input_tokens, null);
  store.close();
});

/** The v1 schema, as shipped before agent_calls existed. */
const V1_SQL = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, workflow_name TEXT NOT NULL,
  trigger_kind TEXT, status TEXT NOT NULL, event_json TEXT NOT NULL,
  started_at INTEGER, finished_at INTEGER, error TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE run_steps (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), name TEXT NOT NULL,
  status TEXT NOT NULL, started_at INTEGER, finished_at INTEGER,
  output_json TEXT, error TEXT, logs TEXT
);
CREATE TABLE events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, type TEXT NOT NULL, scope_id TEXT,
  workflow_name TEXT, dedupe_key TEXT, payload_json TEXT NOT NULL, raw_json TEXT,
  occurred_at INTEGER, received_at INTEGER NOT NULL
);
CREATE TABLE kv (
  namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (namespace, key)
);
`;

test("a v1 database migrates through v3: calls, events, and error fields appear", async () => {
  const path = join(tempDir("steerium-db-"), "state.db");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec(V1_SQL);
  db.prepare("INSERT INTO kv (namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?)").run(
    "__meta__",
    "schema_version",
    "1",
    Date.now(),
  );
  db.close();

  const store = await openSqliteStore(path);
  assert.equal(store.kvGet("__meta__", "schema_version"), 3);
  store.createRun({
    id: "run1",
    scope_id: "global",
    workflow_name: "wf",
    trigger_kind: "manual",
    event_json: "{}",
  });
  store.recordAgentCall({
    id: "c1",
    run_id: "run1",
    step_id: null,
    provider: "mock",
    model: "mock",
    status: "ok",
    input_tokens: 1,
    output_tokens: 2,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: null,
    started_at: 1,
    finished_at: 2,
    error: null,
  });
  store.appendRunEvent("run1", "run.queued", {});
  assert.equal(store.listRunEvents({ runId: "run1" }).length, 1);
  assert.equal(store.listAgentCalls("run1").length, 1);
  store.close();
});

test("a database written by a newer schema version is rejected, not downgraded", async () => {
  const path = join(tempDir("steerium-db-"), "state.db");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec(V1_SQL); // table shapes don't matter here; only the version marker does
  db.prepare("INSERT INTO kv (namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?)").run(
    "__meta__",
    "schema_version",
    "999",
    Date.now(),
  );
  db.close();

  await assert.rejects(openSqliteStore(path), /schema version 999.*newer/);
  // The marker must survive untouched so the newer binary still works.
  const check = new DatabaseSync(path);
  const row = check
    .prepare("SELECT value_json FROM kv WHERE namespace = '__meta__' AND key = 'schema_version'")
    .get() as { value_json: string };
  assert.equal(row.value_json, "999");
  check.close();
});

// ---- runner attribution -------------------------------------------------------

test("agent calls attribute to their step under Promise.all, or null outside steps", async () => {
  const home = freshHome();
  writeWorkflow(
    home,
    "tok",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "tok", on: manual(),
       async run(ctx) {
         await Promise.all([
           ctx.step("a", () => ctx.agent.run({ prompt: "aaaa" })),
           ctx.step("b", () => ctx.agent.run({ prompt: "bb" })),
         ]);
         await ctx.agent.run({ prompt: "outside!" });
       } });`,
  );
  const d = await newDaemon();
  const res = await d.fire("tok", { source: "manual" });
  assert.equal(res.status, "ok");

  const store = d.getStore();
  const calls = store.listAgentCalls(res.runId);
  assert.equal(calls.length, 3);

  // The mock provider reports deterministic usage (char counts), which lets us
  // identify which call is which and pin the step attribution.
  const steps = store.listSteps(res.runId);
  const stepA = steps.find((s) => s.name === "a")!;
  const stepB = steps.find((s) => s.name === "b")!;
  const callA = calls.find((c) => c.input_tokens === "aaaa".length)!;
  const callB = calls.find((c) => c.input_tokens === "bb".length)!;
  const outside = calls.find((c) => c.input_tokens === "outside!".length)!;
  assert.equal(callA.step_id, stepA.id);
  assert.equal(callB.step_id, stepB.id);
  assert.equal(outside.step_id, null);

  assert.equal(callA.status, "ok");
  assert.equal(callA.provider, "mock");
  assert.ok((callA.output_tokens ?? 0) > 0);
  assert.equal(callA.cache_read_tokens, 0);
  await d.shutdown();
});

test("a throwing provider still records an error agent call with unknown usage", async () => {
  const home = freshHome({
    config: `import { defineConfig, defineProvider } from "steerium";
     const boom = defineProvider({ name: "boom", async run() { throw new Error("kaput"); } });
     export default defineConfig({ providers: { boom } });`,
  });
  writeWorkflow(
    home,
    "fail",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "fail", on: manual(),
       async run(ctx) { await ctx.step("s", () => ctx.agent.run({ provider: "boom", prompt: "x" })); } });`,
  );
  const d = await newDaemon();
  const res = await d.fire("fail", { source: "manual" });
  assert.equal(res.status, "failed");

  const store = d.getStore();
  const calls = store.listAgentCalls(res.runId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.status, "failed");
  assert.match(calls[0]!.error ?? "", /kaput/);
  assert.equal(calls[0]!.input_tokens, null); // unknown, never zero
  const step = store.listSteps(res.runId).find((s) => s.name === "s")!;
  assert.equal(calls[0]!.step_id, step.id);
  await d.shutdown();
});

test("an AgentCallError's usage lands on the error row (tokens burned before failure)", async () => {
  const home = freshHome({
    config: `import { defineConfig, defineProvider, AgentCallError } from "steerium";
     const burn = defineProvider({ name: "burn", async run() {
       throw new AgentCallError("aborted mid-run", {
         usage: { inputTokens: 30, outputTokens: 20, cacheReadTokens: 100, model: "claude-opus-5" },
       });
     } });
     export default defineConfig({ providers: { burn } });`,
  });
  writeWorkflow(
    home,
    "burnwf",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "burnwf", on: manual(),
       async run(ctx) { await ctx.agent.run({ provider: "burn", prompt: "x" }); } });`,
  );
  const d = await newDaemon();
  const res = await d.fire("burnwf", { source: "manual" });
  assert.equal(res.status, "failed");

  const calls = d.getStore().listAgentCalls(res.runId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.status, "failed");
  assert.equal(calls[0]!.input_tokens, 30);
  assert.equal(calls[0]!.output_tokens, 20);
  assert.equal(calls[0]!.cache_read_tokens, 100);
  assert.equal(calls[0]!.model, "claude-opus-5");
  await d.shutdown();
});

// ---- provider usage mapping ---------------------------------------------------

test("anthropicUsage: fields are already disjoint, mapped straight through", () => {
  const u = anthropicUsage({
    model: "claude-opus-5",
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 5,
    },
  })!;
  assert.deepEqual(u, {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheCreationTokens: 5,
    model: "claude-opus-5",
  });
  assert.equal(anthropicUsage({ model: "m" }), undefined);
});

test("openaiUsage: cached_tokens is a subset of input_tokens — subtracted to stay disjoint", () => {
  const u = openaiUsage({
    model: "gpt-4o",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 60 },
    },
  })!;
  assert.equal(u.inputTokens, 40);
  assert.equal(u.cacheReadTokens, 60);
  assert.equal(u.outputTokens, 20);
  // Sum of disjoint fields matches OpenAI's own total_tokens.
  assert.equal(
    (u.inputTokens ?? 0) +
      (u.outputTokens ?? 0) +
      (u.cacheReadTokens ?? 0) +
      (u.cacheCreationTokens ?? 0),
    120,
  );
  assert.equal(openaiUsage({}), undefined);
});

test("claudeSdkUsage: uses only the result message (no double count), costUsd carried", () => {
  const assistant = (input: number, output: number) => ({
    type: "assistant",
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 100,
      },
    },
  });
  const messages = [
    assistant(10, 5),
    assistant(20, 15),
    {
      type: "result",
      result: "done",
      total_cost_usd: 0.42,
      usage: {
        input_tokens: 30,
        output_tokens: 20,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 7,
      },
    },
  ];
  const u = claudeSdkUsage(messages)!;
  // Cumulative from the result message — NOT result + assistant sums.
  assert.equal(u.inputTokens, 30);
  assert.equal(u.outputTokens, 20);
  assert.equal(u.cacheReadTokens, 200);
  assert.equal(u.cacheCreationTokens, 7);
  assert.equal(u.costUsd, 0.42);
  assert.equal(u.model, "claude-opus-5");
});

test("claudeSdkUsage: aborted run (no result message) sums assistant usage", () => {
  const messages = [
    { type: "system", subtype: "init" },
    {
      type: "assistant",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: "assistant",
      message: {
        model: "claude-opus-5",
        usage: {
          input_tokens: 20,
          output_tokens: 15,
          cache_read_input_tokens: 100,
        },
      },
    },
  ];
  const u = claudeSdkUsage(messages)!;
  assert.equal(u.inputTokens, 30);
  assert.equal(u.outputTokens, 20);
  assert.equal(u.cacheReadTokens, 100);
  assert.equal(u.costUsd, undefined);
  assert.equal(claudeSdkUsage([{ type: "system" }]), undefined);
});

test("claudeJsonUsage: `claude -p --output-format json` shape", () => {
  const u = claudeJsonUsage({
    result: "hi",
    total_cost_usd: 0.05,
    usage: { input_tokens: 4, output_tokens: 8, cache_read_input_tokens: 12 },
  })!;
  assert.equal(u.inputTokens, 4);
  assert.equal(u.outputTokens, 8);
  assert.equal(u.cacheReadTokens, 12);
  assert.equal(u.costUsd, 0.05);
  assert.equal(claudeJsonUsage({ result: "hi" }), undefined);
});

test("claudeResultError: is_error / error_* results are failures, success is not", () => {
  assert.equal(
    claudeResultError([{ type: "result", subtype: "success", is_error: false, result: "done" }]),
    null,
  );
  assert.match(
    claudeResultError([{ type: "result", subtype: "error_max_turns", is_error: true }]) ?? "",
    /error_max_turns/,
  );
  assert.match(
    claudeResultError([
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "boom",
      },
    ]) ?? "",
    /error_during_execution: boom/,
  );
  // No result message at all (aborted) is not, by itself, an error result.
  assert.equal(claudeResultError([{ type: "assistant" }]), null);
});

test("codexUsage: cached_input_tokens is a subset of input_tokens — subtracted", () => {
  const u = codexUsage({
    finalResponse: "ok",
    usage: { input_tokens: 100, cached_input_tokens: 70, output_tokens: 10 },
  })!;
  assert.equal(u.inputTokens, 30);
  assert.equal(u.cacheReadTokens, 70);
  assert.equal(u.outputTokens, 10);
  assert.equal(codexUsage({ finalResponse: "ok" }), undefined);
});
