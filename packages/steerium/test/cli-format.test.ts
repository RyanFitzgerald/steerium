/**
 * The CLI's argument parsing and token-accounting formatters. cli.test.ts drives
 * these through a real process; this file pins the edge cases that are tedious
 * to reach end to end — chiefly the unknown-vs-zero rule for usage columns.
 */
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, resolveProjectFlag, scopeLabel } from "../src/cli/args.js";
import { fmtRunUsage, fmtStepCalls, fmtTok, grandTotal, sumAgentCalls } from "../src/cli/format.js";
import { stripAnsi } from "../src/cli/style.js";
import type { AgentCallRecord } from "../src/types.js";
import { freshHome, freshProject, tempDir } from "./helpers.js";

// ---- parseArgs -----------------------------------------------------------------

test("parseArgs splits positionals from flags", () => {
  assert.deepEqual(parseArgs(["workflow", "run", "hello"]), {
    _: ["workflow", "run", "hello"],
    flags: {},
  });
  assert.deepEqual(parseArgs(["logs", "--limit", "20"]), {
    _: ["logs"],
    flags: { limit: "20" },
  });
});

test("parseArgs treats a flag with no value as boolean true", () => {
  assert.deepEqual(parseArgs(["logs", "--follow"]).flags, { follow: true });
  // A flag immediately followed by another flag takes no value.
  assert.deepEqual(parseArgs(["logs", "--follow", "--limit", "5"]).flags, {
    follow: true,
    limit: "5",
  });
  // Trailing flag at the end of argv.
  assert.deepEqual(parseArgs(["start", "--project"]).flags, { project: true });
});

test("parseArgs keeps JSON values intact", () => {
  const args = parseArgs(["workflow", "run", "echo", "--input", '{"url":"https://x.com"}']);
  assert.deepEqual(args._, ["workflow", "run", "echo"]);
  assert.deepEqual(JSON.parse(args.flags.input as string), {
    url: "https://x.com",
  });
});

test("parseArgs on an empty argv yields an empty parse, not a crash", () => {
  assert.deepEqual(parseArgs([]), { _: [], flags: {} });
});

// ---- resolveProjectFlag ---------------------------------------------------------

test("--global always wins, even inside a project directory", () => {
  freshHome();
  const proj = freshProject();
  assert.equal(resolveProjectFlag(parseArgs(["--global"]), proj), undefined);
  // ...and even alongside an explicit --project.
  assert.equal(resolveProjectFlag(parseArgs(["--global", "--project", proj]), proj), undefined);
});

test("--project takes a path, or means the cwd when bare", () => {
  freshHome();
  const proj = freshProject();
  assert.equal(resolveProjectFlag(parseArgs(["--project", proj]), "/elsewhere"), proj);
  assert.equal(resolveProjectFlag(parseArgs(["--project"]), proj), proj);
});

test("a cwd containing .steerium/ is auto-detected; a plain directory is not", () => {
  freshHome();
  assert.equal(resolveProjectFlag(parseArgs([]), freshProject()) !== undefined, true);
  assert.equal(resolveProjectFlag(parseArgs([]), tempDir("plain-")), undefined);
});

test("STEERIUM_HOME itself is never treated as a project, even with .steerium/ in it", () => {
  // The home has its own workflows; auto-detecting it as a project would load
  // the same workflows twice under two different scopes.
  const home = freshHome();
  mkdirSync(join(home, ".steerium"), { recursive: true });
  assert.equal(resolveProjectFlag(parseArgs([]), home), undefined);
});

test("scopeLabel renders global as-is and strips the project: prefix", () => {
  assert.equal(scopeLabel("global"), "global");
  assert.equal(scopeLabel("project:/srv/app"), "/srv/app");
});

// ---- fmtTok ---------------------------------------------------------------------

test("fmtTok abbreviates at thousands and millions, losing precision as it grows", () => {
  assert.equal(fmtTok(0), "0");
  assert.equal(fmtTok(999), "999");
  assert.equal(fmtTok(1000), "1.0k");
  assert.equal(fmtTok(1234), "1.2k");
  assert.equal(fmtTok(9999), "10.0k");
  assert.equal(fmtTok(10_000), "10k");
  assert.equal(fmtTok(905_400), "905k");
  assert.equal(fmtTok(1_000_000), "1.0M");
  assert.equal(fmtTok(12_345_678), "12M");
});

// ---- usage totals ----------------------------------------------------------------

let seq = 0;
function call(partial: Partial<AgentCallRecord> = {}): AgentCallRecord {
  seq += 1;
  return {
    id: `c${seq}`,
    run_id: "run1",
    step_id: "s1",
    provider: "mock",
    model: "m",
    status: "ok",
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 30,
    cache_creation_tokens: 40,
    cost_usd: null,
    started_at: 0,
    finished_at: 1,
    error: null,
    ...partial,
  };
}

/** A call whose provider reported nothing at all. */
const unknownCall = (p: Partial<AgentCallRecord> = {}) =>
  call({
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    ...p,
  });

test("sumAgentCalls adds the four disjoint columns and counts known vs unknown", () => {
  const t = sumAgentCalls([call(), call(), unknownCall()]);
  assert.deepEqual(t, {
    input: 20,
    output: 40,
    cacheRead: 60,
    cacheCreation: 80,
    known: 2,
    unknown: 1,
  });
  assert.equal(grandTotal(t), 200);
});

test("a call reporting only one column still counts as known", () => {
  // Partial reporting is common: one number is data, not absence of data.
  const t = sumAgentCalls([
    call({
      input_tokens: 5,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
    }),
  ]);
  assert.equal(t.known, 1);
  assert.equal(t.unknown, 0);
  assert.equal(t.input, 5);
  assert.equal(grandTotal(t), 5);
});

test("a call reporting an explicit zero is known, not unknown", () => {
  // This is the distinction the whole scheme rests on: 0 is a measurement.
  const t = sumAgentCalls([
    call({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    }),
  ]);
  assert.equal(t.known, 1);
  assert.equal(t.unknown, 0);
  assert.equal(grandTotal(t), 0);
});

test("sumAgentCalls on no calls is all zeros with nothing known", () => {
  assert.deepEqual(sumAgentCalls([]), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    known: 0,
    unknown: 0,
  });
});

// ---- step and run annotations ------------------------------------------------------

test("fmtStepCalls is empty for a deterministic step", () => {
  assert.equal(fmtStepCalls([]), "");
});

test("fmtStepCalls names the providers, counts repeats, and totals tokens", () => {
  const one = fmtStepCalls([call()]);
  assert.match(one, /agent: mock · 100 tok/);
  assert.ok(!one.includes("×"), "a single call needs no multiplier");

  const many = fmtStepCalls([call(), call({ provider: "anthropic" })]);
  assert.match(many, /agent: mock,anthropic ×2 · 200 tok/);
});

test("fmtStepCalls says 'usage unknown' when no call in the step reported anything", () => {
  const line = fmtStepCalls([unknownCall(), unknownCall()]);
  assert.match(line, /agent: mock ×2 · usage unknown/);
  assert.ok(!line.includes("0 tok"), "0 must never stand in for unknown");
});

test("fmtStepCalls reports partial knowledge as a total plus an unknown count", () => {
  assert.match(fmtStepCalls([call(), unknownCall()]), /· 100 tok \(\+1 unknown\)/);
});

test("fmtRunUsage is empty for a run that made no agent calls", () => {
  assert.deepEqual(fmtRunUsage([], 3), []);
});

test("fmtRunUsage counts deterministic steps and pluralizes correctly", () => {
  const [summary] = fmtRunUsage([call({ step_id: "s1" })], 3);
  assert.match(summary!, /agent: 1 call \(mock\) · 2 of 3 steps deterministic/);

  const [twoCalls] = fmtRunUsage([call({ step_id: "s1" }), call({ step_id: "s2" })], 3);
  assert.match(twoCalls!, /agent: 2 calls \(mock ×2\) · 1 of 3 steps deterministic/);
});

test("fmtRunUsage counts several calls in one step as a single non-deterministic step", () => {
  const [summary] = fmtRunUsage([call({ step_id: "s1" }), call({ step_id: "s1" })], 2);
  assert.match(summary!, /1 of 2 steps deterministic/);
});

test("fmtRunUsage does not let calls outside any step consume a step slot", () => {
  const [summary] = fmtRunUsage([call({ step_id: "s1" }), call({ step_id: null })], 2);
  assert.match(summary!, /agent: 2 calls/);
  assert.match(summary!, /1 of 2 steps deterministic/);
});

test("fmtRunUsage breaks the total down by column when usage is known", () => {
  const lines = fmtRunUsage([call()], 1);
  assert.match(stripAnsi(lines[1]!), /tokens: 100 total — 10 in \/ 20 out \/ 30 cache-read \/ 40 cache-write/);
});

test("fmtRunUsage reports a wholly unreported run as unknown, never as zero", () => {
  const lines = fmtRunUsage([unknownCall()], 1);
  assert.match(stripAnsi(lines[1]!), /tokens: unknown \(provider did not report usage\)/);
  assert.ok(!lines[1]!.includes("0 total"));
});

test("fmtRunUsage annotates a mixed run with how many calls went unreported", () => {
  const lines = fmtRunUsage([call(), unknownCall()], 1);
  assert.match(stripAnsi(lines[1]!), /tokens: 100 total — .* · 1 call usage unknown/);
  const two = fmtRunUsage([call(), unknownCall(), unknownCall()], 1);
  assert.match(stripAnsi(two[1]!), /· 2 calls usage unknown/);
});
