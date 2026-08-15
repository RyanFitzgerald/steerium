---
title: Advanced workflows
description: Patterns for multi-stage, agent-driven automation — pipelines, structured output, parameterized runs, chaining, and tuning.
sidebar:
  order: 1
---

A workflow is a plain async function, so "advanced" mostly means composing
the pieces you already have: steps, providers, connectors, artifacts, and the
control API. This page collects the patterns that come up once workflows grow
past a single agent call.

## Plan → implement → verify

The most reliable agent workflows split work into stages with different
providers per stage: a cheap API call to plan, a coding agent to implement,
and a deterministic step to verify. Each stage lands in the run record, so
when something fails you can see exactly which stage did.

```ts
import { defineWorkflow, github } from "steerium";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export default defineWorkflow({
  name: "issue-fixer",
  on: github.issueOpened({ repo: "acme/app", labels: ["auto-fix"] }),
  timeoutMs: 45 * 60_000,
  async run(ctx) {
    const { issue } = ctx.event;

    const plan = await ctx.step("plan", () =>
      ctx.agent.run({
        provider: "openai",
        prompt: `Plan a minimal fix for:\n\n${issue.title}\n\n${issue.body}`,
      }),
    );

    await ctx.step("implement", () =>
      ctx.agent.run({
        provider: "claude",
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Edit", "Bash"],
        prompt: `Implement this plan:\n\n${plan.text}`,
      }),
    );

    // Deterministic verification — the agent doesn't grade its own homework.
    await ctx.step("test", async () => {
      await exec("npm", ["test"], { cwd: ctx.scope.cwd, signal: ctx.signal });
    });

    await ctx.artifact.writeText("plan.md", plan.text);
  },
});
```

If `npm test` fails, the step throws, the run is marked `failed` at the `test`
step, and nothing gets papered over. Fix the workflow (or the repo) and
`steerium replay <runId>` against the same issue event.

## Structured output

`outputSchema` asks the provider for JSON matching a schema instead of prose.
OpenAI, Anthropic, Codex, and Claude support it. The result is parsed into
`result.data`; plain JSON Schema and structural Standard Schema values are
accepted:

```ts
type Verdict = { severity: "low" | "medium" | "high"; area: string };

const verdict = await ctx.step("classify", () =>
  ctx.agent.run<Verdict>({
    provider: "openai",
    prompt: `Classify this issue:\n\n${issue.title}\n\n${issue.body}`,
    outputSchema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["low", "medium", "high"] },
        area: { type: "string" },
      },
      required: ["severity", "area"],
      additionalProperties: false,
    },
  }),
);

const { severity, area } = verdict.data!;
if (severity !== "high") return; // only escalate the bad ones
```

## Parameterized manual workflows

`manual()` workflows accept an arbitrary payload — from the CLI, the UI, or
the control API — which arrives as `ctx.event.input`:

```ts
import { defineWorkflow, manual } from "steerium";

interface ReleaseInput {
  version: string;
  dryRun?: boolean;
}

export default defineWorkflow({
  name: "release",
  on: manual(),
  async run(ctx) {
    const input = ctx.event.input as ReleaseInput;
    if (!input?.version) throw new Error("release: pass --input '{\"version\": \"1.2.3\"}'");
    // ...
  },
});
```

```bash
steerium workflow run release --input '{"version": "1.2.3", "dryRun": true}'
```

Or over HTTP — the JSON body of `POST /run/release` is the input. Validate
the input at the top and throw early: a run that fails on its first line is a
clear run record.

## Chaining workflows

Workflows can fire other workflows through the control API. `POST
/run/<name>` resolves when the child run settles and returns its `runId` and
status, so a dispatcher can fan work out to focused single-purpose workflows
and still fail loudly when a child fails:

```ts
await ctx.step("dispatch", async () => {
  const res = await fetch("http://127.0.0.1:4319/run/pr-review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: pr.repo, number: pr.number }),
    signal: ctx.signal,
  });
  const child = (await res.json()) as { runId: string; status: string; error?: string };
  if (child.status !== "ok") throw new Error(`pr-review run ${child.runId} failed: ${child.error}`);
  return child.runId; // recorded as the step's output
});
```

The child gets its own run record, its own timeout, and its own artifacts —
which is the point. Prefer this over one giant workflow when stages have
different concurrency or timeout needs.

## Long runs, timeouts, and cancellation

`timeoutMs` aborts a run through `ctx.signal`; providers forward it, so
in-flight HTTP calls and agent subprocesses actually stop. Two habits keep
long workflows honest:

- **Pass the signal down.** `execFile(cmd, args, { signal: ctx.signal })`,
  `fetch(url, { signal: ctx.signal })` — anything you spawn should die when
  the run does.
- **Check it in loops.** Between iterations of your own long loops:

```ts
for (const repo of repos) {
  if (ctx.signal.aborted) throw new Error("cancelled");
  await ctx.step(`sync ${repo}`, () => sync(repo));
}
```

`steerium cancel <runId>` goes through the same signal, so a workflow that
handles timeouts correctly handles cancellation for free.

## Tuning concurrency and the queue

Defaults: `concurrency: 1`, `queue: 10`. For agent workflows in a repo,
keep concurrency at 1 — two agents editing one checkout is a bad time — and
size the queue for your burst pattern:

```ts
export default defineWorkflow({
  name: "ticket-agent",
  on: linear.ticketMoved({ to: "Todo" }),
  concurrency: 1,   // one agent in the repo at a time
  queue: 25,        // a sprint-planning burst of tickets queues up
  // ...
});
```

For stateless API-only workflows, raising `concurrency` is safe and events
process in parallel. `queue: 0` restores strict drop-on-overlap for
workflows where a stale queued event is worse than a missed one (e.g. a
"sync latest" job where only the newest event matters).

## Artifacts as the contract between steps

`ctx.artifact.dir` is an absolute path unique to the run. Agent providers
can write there directly — tell them where it is:

```ts
await ctx.agent.run({
  provider: "claude",
  permissionMode: "acceptEdits",
  prompt: `Audit the dependency tree and write the full report to ${ctx.artifact.dir}/audit.md. Reply with a two-line summary.`,
});
```

The agent's reply stays small (it lands in the step output), the real
deliverable is downloadable from the run detail page, and `steerium run
<runId>` shows both.

## The development loop

Single-shot commands act in-process when no daemon is running — they load
your workflow file fresh on every invocation. That makes the edit-run loop
immediate:

```bash
steerium workflow run my-workflow --input '{"x": 1}'   # loads current code
# edit the file...
steerium workflow run my-workflow --input '{"x": 1}'   # loads it again
```

For trigger-driven workflows, capture a real event once, then iterate with
replay — it re-runs your **current** code against the **stored** event:

```bash
steerium logs                 # find the run that captured the event
steerium replay <runId>       # re-run edited workflow, same event
```

The original run records the workflow file/hash, Steerium and Node versions,
Git SHA/dirty state, and a secret-free config fingerprint. Replay deliberately
uses the currently loaded code; compare the two run provenance records when
you need to explain a changed result.

Start with `provider: "mock"` (deterministic echo, no credentials) to test
the wiring, then swap in real providers. A running daemon loads workflows at
startup, so restart it when you're done iterating.
