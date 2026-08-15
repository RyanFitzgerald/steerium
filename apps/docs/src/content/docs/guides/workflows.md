---
title: Writing workflows
description: The workflow definition and the context passed to every run.
sidebar:
  order: 1
---

A workflow is one TypeScript file exporting a `defineWorkflow` call. The
trigger lives with the handler — there is no separate registration step.

```ts
import { defineWorkflow, manual } from "steerium";

export default defineWorkflow({
  name: "summarize",
  on: manual(),
  timeoutMs: 5 * 60_000,   // optional; default 5 min
  concurrency: 1,          // optional; default 1
  queue: 10,               // optional; events past this bound are dropped
  tags: ["content"],       // optional; shown in listings
  async run(ctx) {
    // ordinary Node — import whatever you need
  },
});
```

Workflows are loaded at runtime with [jiti](https://github.com/unjs/jiti) —
you never build them.

## The workflow context

Inside `run(ctx)`:

| Member | What it is |
|---|---|
| `ctx.event` | the typed, persisted event that caused this run |
| `ctx.agent.run(opts)` | AI/agent call: `provider`, `prompt`, `system`, `model`, `maxTokens`, `cwd`, and for agent providers `permissionMode`, `allowedTools`, `outputSchema` |
| `ctx.step(name, fn)` | wrap a stage; status, output, and logs land in the run record and UI |
| `ctx.artifact` | `writeText` / `writeJSON` / `writeBytes` — files under this run's artifact directory |
| `ctx.connector(name)` | resolved connector config (secrets included) |
| `ctx.state` | persistent key/value state private to this workflow — cursors, "last processed" markers |
| `ctx.kv(name)` | a named key/value namespace shared across the scope — how workflows (and triggers) hand state to each other; [approvals](/guides/approvals/) are built on it |
| `ctx.scope` | where you're running — `scope.cwd` is the repo for project workflows |
| `ctx.logger` | structured logger bound to this run |
| `ctx.runId` | the run's id |
| `ctx.signal` | `AbortSignal` — aborts on timeout or cancellation |

## Steps

`ctx.step` is bookkeeping, not durability: each step records its status,
JSON-serialized return value, and captured logs to the run record, which is
what the UI renders live during long runs. Steps are not checkpoints — a
replayed run starts from the top.

```ts
const plan = await ctx.step("plan", () =>
  ctx.agent.run({ provider: "openai", prompt: "..." }),
);

await ctx.step("implement", () =>
  ctx.agent.run({ provider: "claude", prompt: plan.text }),
);
```

## Runtime guarantees

**Concurrency and queueing.** `concurrency` caps simultaneous runs of a
workflow in its scope (default 1). Events over the cap wait in a bounded
per-workflow FIFO (`queue`, default 10) and run as slots free; only events past
the bound are dropped, with a warning. `queue: 0` means strict
drop-on-overlap.

Every event receives a run ID immediately. The run timeline records
`run.queued`, execution/step/agent/artifact events, then a precise terminal
outcome: `ok`, `failed`, `cancelled`, `timed_out`, `interrupted`, or `dropped`.
Errors include a code, message, and optional details.

**Timeouts.** `timeoutMs` (default 5 min) aborts a run via its `AbortSignal`;
providers forward it so in-flight HTTP calls and agent subprocesses actually
stop. Give coding-agent workflows a longer leash (e.g. 45 min).

**Cancellation.** `steerium cancel <runId>` (or the UI's cancel button) aborts
an executing run through the same signal path as the timeout.

**Crash recovery.** On startup the daemon marks runs left `running` by a
crashed process as `interrupted` — no phantom in-progress runs.

**No automatic retries — deliberately.** Agents mutate state (commits,
comments, branches); blind retries duplicate side effects. `steerium replay
<runId>` is the deliberate, manual re-run against the exact stored event.
Each run captures workflow/config hashes and runtime/Git identity; replay uses
the current loaded code, not a hidden historical code snapshot.

## Going further

Multi-stage pipelines, structured output, parameterized manual runs,
chaining workflows, and tuning concurrency are covered in
[advanced workflows](/extending/advanced-workflows/).
