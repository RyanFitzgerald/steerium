<img width="2172" height="724" alt="steerium" src="./assets/steerium-readme-banner.png" />

# steerium

**A local-first TypeScript workflow orchestrator for deterministic code, AI
calls, and coding agents.**

steerium runs ordinary TypeScript files when a trigger fires: cron schedules,
manual runs, tickets, GitHub issues or PRs, and signature-verified webhooks. A
workflow is just an async function, so it can be deterministic, agent-driven,
or both: run Node logic, shell out to git or npm, call OpenAI or Anthropic, or
drive Codex or Claude inside the target repo.

Every run records the triggering event, step output, logs, and artifacts so it
can be inspected or replayed. The same model works for global workflows in
`~/.steerium/` and project workflows in `<repo>/.steerium/`, where the workflow
runs with the repo as `cwd`.

steerium is built for developer workflows that need to live with your code:
*prune merged branches every morning. Draft the changelog every Friday. Review
every PR when it opens. When a ticket moves to Todo, have an agent take a first
pass.* Each workflow is one file:

```ts
// ~/code/my-app/.steerium/workflows/implement.ts
import { defineWorkflow, linear } from "steerium";

export default defineWorkflow({
  name: "implement",
  on: linear.ticketMoved({ to: "Todo" }),   // the trigger lives with the handler
  timeoutMs: 45 * 60_000,
  async run(ctx) {
    const { ticket } = ctx.event;

    const plan = await ctx.step("plan", () =>
      ctx.agent.run({ provider: "openai", prompt: `Plan ${ticket.identifier}: ${ticket.title}` }),
    );

    await ctx.step("implement", () =>
      ctx.agent.run({
        provider: "claude",                 // a real coding agent, in this repo
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Edit", "Bash"],
        prompt: `Implement this plan:\n\n${plan.text}`,
      }),
    );

    await ctx.artifact.writeText("plan.md", plan.text);
  },
});
```

## Features

- **Deterministic, AI, or both** — plain async TypeScript functions. Use fs,
  git, shell commands, APIs, and any npm package; call AI providers or coding
  agents only when the workflow needs them. No DSL, no YAML.
- **One trigger abstraction** — cron schedules, intervals, Linear/Jira/GitHub
  events (poll or signature-verified webhook), and manual fires all implement
  the same interface. Custom triggers are first-class.
- **Providers, chosen per call** — OpenAI and Anthropic by API key, or Codex
  and Claude as real coding agents. On a laptop, agent providers can use your
  existing CLI subscription; on a server, the same workflow runs on API keys.
- **Every run is a record** — the triggering event, typed append-only timeline,
  provenance, per-step status/output, agent usage, and artifacts persist in
  SQLite. `steerium replay <runId>` re-runs the current workflow code against
  the exact stored event.
- **Human-in-the-loop approvals** — `approvals.request` asks a question and
  the run ends; a second workflow fires on each reply. Answer over the
  control API/UI or a Slack-style transport. Pending approvals live in the
  store, not a blocked process, so they survive restarts and sleep.
- **Global and per-project** — shared workflows in `~/.steerium/`, repo
  workflows in `<repo>/.steerium/` running with the repo as `cwd`; project
  config overrides global.
- **Local-first, self-hosted** — a single daemon with a localhost control API,
  a CLI, and an optional browser UI. No hosted platform in between.

## Installation

Requires Node **>= 22.13**.

```bash
npm install -g steerium
```

## Quick start

No API keys needed — the default `mock` provider is deterministic:

```bash
steerium init                 # scaffold ~/.steerium + starter workflows
steerium workflow run hello   # fire a workflow once
steerium logs                 # every run is recorded
steerium start                # run the daemon: triggers, control API, browser UI
```

Your workflows and config are TypeScript loaded at runtime — you never build
them. When you're ready for real providers, set an API key (or have the
`claude`/`codex` CLI installed) and run `steerium doctor` to see what resolved.

## Examples

Complete, copy-pasteable workflows live in [examples/](./packages/steerium/examples/):

| Use case | Trigger | The gist |
|---|---|---|
| [Automated PR review](./packages/steerium/examples/pr-review.ts) | GitHub PR opens | coding agent reviews the diff in the repo, comments back |
| [Ticket → coding agent](./packages/steerium/examples/ticket-agent.ts) | Linear/Jira status change | plan with an API call, implement with an agent on a branch |
| [Scheduled content](./packages/steerium/examples/daily-content.ts) | cron | draft and save a post every day at 2pm |
| [Approval-gated publishing](./packages/steerium/examples/blog-draft.ts) | cron + approval reply | draft daily, [ask a human](./packages/steerium/examples/blog-approve.ts); approve → commit + push, feedback → revise and re-ask |
| [Repo housekeeping](./packages/steerium/examples/repo-housekeeping.ts) | interval | no AI at all — prune merged branches, log what happened |

## How it works

Three primitives, one loop:

| Primitive | What it is | Built-ins |
|---|---|---|
| **Trigger** | emits events | cron, interval, Linear/Jira/GitHub poll or webhook, approval replies, manual |
| **Workflow** | an async TypeScript function handling one event | yours |
| **Provider** | executes an AI or agent call | `openai`, `anthropic`, `codex`, `claude`, `mock` |

An event arrives → it's deduped and persisted → a run row is created → your
function executes (steps and artifacts recorded) → the run is marked ok or
error. The daemon (`steerium start`) keeps triggers live; a localhost control
API serves the CLI and a small browser UI at `http://127.0.0.1:4319/` — run
history, live step logs, "run now", "replay".

Workflows live at two levels, and project config overrides global:

- **Global** — `~/.steerium/workflows/`, runs with `cwd = ~/.steerium`. Shared
  automation (daily content, housekeeping).
- **Project** — `<repo>/.steerium/workflows/`, runs with `cwd = the repo`.
  This is what makes coding-agent workflows natural: the agent operates in the
  actual checkout.

## Usage

### A scheduled workflow

```ts
// ~/.steerium/workflows/daily-blog.ts
import { defineWorkflow, schedule } from "steerium";

export default defineWorkflow({
  name: "daily-blog",
  on: schedule.cron("0 14 * * *", { tz: "America/Montreal" }),
  async run(ctx) {
    const post = await ctx.step("write", () =>
      ctx.agent.run({
        provider: "anthropic",
        system: "Concise technical blogger. Markdown only.",
        prompt: "Write a 600-word post on a practical software engineering idea.",
      }),
    );
    await ctx.artifact.writeText("post.md", post.text);
  },
});
```

`steerium start` registers the cron; each firing is a recorded, replayable run.

### A ticket-driven workflow

Register the project, put the connector key in config, drop a workflow in the
repo:

```bash
steerium project add ~/code/my-app     # registers + scaffolds .steerium/
```

> A globally running daemon reads the project registry **at startup**. If
> `steerium start` is already running, restart it after `project add`, then
> confirm the pickup with `steerium status` — it lists every project the
> daemon loaded and flags any registered after it started.

```ts
// ~/code/my-app/.steerium/config.ts — merged over global config, project wins
import { defineConfig } from "steerium";

export default defineConfig({
  connectors: { linear: { apiKey: { env: "LINEAR_API_KEY" } } },
});
```

```ts
// ~/code/my-app/.steerium/workflows/triage.ts
import { defineWorkflow, linear } from "steerium";

export default defineWorkflow({
  name: "triage",
  on: linear.ticketMoved({ to: "Todo", intervalMs: 60_000 }), // poll every 60s
  async run(ctx) {
    const { ticket } = ctx.event;
    const summary = await ctx.step("summarize", () =>
      ctx.agent.run({
        provider: "openai",
        prompt: `One-line summary of ${ticket.identifier}: ${ticket.title}\n\n${ticket.description}`,
      }),
    );
    await linear.comment(ctx.connector("linear").apiKey, ticket.id, summary.text);
  },
});
```

Polling dedupes through a persistent cursor, so an issue fires once. With a
public URL, the same trigger switches to signature-verified webhooks via
config — the workflow doesn't change. Jira and GitHub follow the identical
shape.

### Manual workflows with input

```bash
steerium workflow run summarize --input '{"url":"https://example.com"}'
```

`--input` arrives as `ctx.event.input`. Manual triggers (`on: manual()`) are
also fireable from the browser UI and the control API.

### Project-scoped mode

Run `steerium start` inside a repo containing `.steerium/` and the daemon
scopes itself to that project: only its workflows load, with its config. No
global registration needed — works in a fresh clone or CI.

```bash
cd ~/code/my-app
steerium start                            # project scope, auto-detected
steerium start --global                   # force the global daemon
steerium start --project ~/code/other-app # explicit
```

State and run history still live in `STEERIUM_HOME`, so `steerium logs` and
`replay` see runs from either mode. Global workflows don't run in project mode.

## CLI reference

```
steerium init                  scaffold .steerium/ + starter workflows
steerium project add <path>    register a project
steerium project list
steerium config export         bundle config + workflows + project registry  [--out <file>]
steerium config import <file>  restore a bundle on this machine  [--force]
steerium start                 run the daemon (triggers + control API + UI)
                               [--project [path]] [--global]
steerium workflow list
steerium workflow run <name>   fire one workflow once  [--input <json>] [--project <path>]
steerium logs [--follow]       recent run history
steerium run <runId>           show a run's detail + steps
steerium replay <runId>        re-run a workflow against its stored event
steerium cancel <runId>        abort an executing run (requires a running daemon)
steerium status                query a running daemon
steerium doctor                check Node version, provider auth, connector config
```

Single-shot commands work without a running daemon (they act in-process); when
a daemon **is** running they go through its control API.

## Triggers

| Trigger | Fires on |
|---|---|
| `manual()` | `steerium workflow run <name>`, the UI, or the control API |
| `schedule.cron(expr, { tz })` | a cron schedule (via `croner`) |
| `schedule.every(ms)` | a fixed interval |
| `approvals.responded({ via? })` | a human reply to a pending approval |
| `linear.ticketMoved({ to, intervalMs? })` | a Linear issue entering a state |
| `jira.issueTransitioned({ to, jql?, intervalMs? })` | a Jira issue transition |
| `github.issueOpened({ repo, labels?, intervalMs? })` | a new GitHub issue (optionally label-filtered) |
| `github.prOpened({ repo, intervalMs? })` | a new GitHub pull request |

All of these implement one interface, and custom triggers are first-class:
implement `start(ctx, emit)`, get persistent state for dedup cursors and
webhook registration for free. [linear.ts](./packages/steerium/src/connectors/linear.ts) is the
~170-line reference.

## The workflow context

Inside `run(ctx)`:

- `ctx.event` — the typed, persisted event that caused this run
- `ctx.agent.run(opts)` — AI/agent call: `provider`, `prompt`, `system`,
  `model`, `maxTokens`, `cwd`, and for agent providers `permissionMode`,
  `allowedTools`, `outputSchema`
- `ctx.step(name, fn)` — wrap a stage; status, output, and logs land in the
  run record and UI
- `ctx.artifact.writeText/writeJSON/writeBytes` — files under this run's
  artifact directory
- `ctx.connector(name)` — resolved connector config (secrets included)
- `ctx.state` — persistent key/value state private to this workflow;
  `ctx.kv(name)` — a named namespace shared across the scope (approvals are
  built on it)
- `ctx.scope` — where you're running (`scope.cwd` is the repo for project
  workflows), `ctx.logger`, `ctx.runId`, and `ctx.signal` (aborts on timeout)

Everything else is ordinary Node — import whatever you need.

`outputSchema` accepts plain JSON Schema or a structural Standard Schema value.
OpenAI, Anthropic, Codex, and Claude enforce it, and the typed result is exposed
as `AgentResult<T>.data`. Custom providers must explicitly declare
`supportsStructuredOutput: true`; unsupported providers fail before a call.

## Approvals

A human-in-the-loop gate, without durable runs: `approvals.request` posts a
question and **returns** — the run ends, the pending record lives in the
store. A second workflow listens with `approvals.responded()` and fires once
per reply, so waiting survives restarts and holds no concurrency slot.

```ts
// ask (run ends immediately)
await approvals.request(ctx, {
  id: `blog-${date}`,
  text: "Draft ready. Reply \"approve\" or with feedback.",
  options: [{ value: "approve", label: "Approve" }],
  allowFreeform: true,
  payload: { draft: draft.text, date },
});

// respond (a separate workflow)
on: approvals.responded(),
async run(ctx) {
  const { approval, reply } = ctx.event;
  if (isApprove(reply!.text)) { /* commit + push */ await approvals.resolve(ctx, approval.id); }
  else { /* revise */ await approvals.reask(ctx, { id: approval.id, text: revised.text }); }
}
```

Answer in the browser UI or POST `text` plus the current per-round `requestId`.
Every reask rotates that ID, so stale replies cannot answer a newer question
(a missing ID is accepted only on round one for compatibility). Or plug in an
`ApprovalTransport` to deliver requests to Slack
and poll the thread for replies — both paths work on the same approval. Each
feedback round is just another event, so revision loops need no loop
construct. TTLs (`ttlMs`) expire unanswered requests with an `expired` event.

## Providers

Two tiers, one interface. A workflow says `provider: "x"` and doesn't care
which tier it is.

| Provider    | Tier        | Auth                                        |
|-------------|-------------|---------------------------------------------|
| `mock`      | —           | none (default; deterministic echo)          |
| `openai`    | HTTP API    | `OPENAI_API_KEY`                            |
| `anthropic` | HTTP API    | `ANTHROPIC_API_KEY`                         |
| `codex`     | agent       | your existing `codex` CLI login (no key)    |
| `claude`    | agent       | your existing Claude Code login (no key)    |

The split that matters: **API providers** are metered and stateless — the
server story. **Agent providers** drive a real coding agent in a working
directory and, on your own machine, can authenticate through your existing
CLI subscription at zero marginal cost — the laptop story. steerium never
silently bridges a personal subscription on a shared server; use API keys
there. `steerium doctor` reports which auth method each provider resolved to.

Agent providers prefer their SDK (installed automatically as an optional
dependency) and fall back to the raw CLI (`codex exec`, `claude -p`) only when
the SDK isn't present. Either way they spawn the same binary you use
interactively, so there is nothing to authenticate beyond the login you
already did. Without a `permissionMode` they run read-only — set
`permissionMode: "acceptEdits"` for workflows that should edit files.

## Configuration

Global config in `~/.steerium/config.ts`; per-project `.steerium/config.ts`
merges over it (project wins). Secrets are env references, never literals, and
are redacted from logs.

```ts
import { defineConfig } from "steerium";

export default defineConfig({
  defaults: { provider: "anthropic" },
  providers: {
    anthropic: { apiKey: { env: "ANTHROPIC_API_KEY" } },
  },
  connectors: {
    linear: { apiKey: { env: "LINEAR_API_KEY" } },
    github: { token: { env: "GITHUB_TOKEN" } },
  },
  control: { host: "127.0.0.1", port: 4319 },
});
```

### Moving to a new machine

The whole config layer is files, so it ports as one bundle:

```bash
steerium config export --out steerium-config.json   # on the old machine
steerium config import steerium-config.json         # on the new one
```

The bundle contains global `config.ts`, everything under `~/.steerium/workflows/`,
and the project registry. Import writes them into the new `STEERIUM_HOME`
(existing files are kept unless `--force`), then re-registers each project:
paths that exist are registered as-is, paths under the old home directory are
remapped to the new one (`/Users/olduser/code/app` → `/Users/newuser/code/app`),
and anything else is reported so you can clone it and `steerium project add` it.

Two things deliberately don't travel: run history (`state.db`, artifacts, logs
are machine-local state, not config) and credentials — secrets are env
references, so the bundle never contains a key. Set the same env vars on the
new machine and run `steerium doctor` to confirm everything resolved.
Per-project `.steerium/` directories live in their repos, so they arrive with
`git clone`.

## Runtime guarantees

**Concurrency and queueing.** `concurrency` caps simultaneous runs of a
workflow in its scope (default 1). Events over the cap wait in a bounded
per-workflow FIFO (`queue`, default 10) and run as slots free; only events past
the bound are dropped, with a warning. `queue: 0` means strict drop-on-overlap.
Queued and dropped work receives a run ID and timeline too.

**Lifecycle outcomes.** Runs distinguish `queued`, `running`, `ok`, `failed`,
`cancelled`, `timed_out`, `interrupted`, and `dropped`; errors carry a stable
code plus message/details. Steps and agent calls use the matching precise
outcomes instead of collapsing everything into `error`.

**Timeouts.** `timeoutMs` (default 5 min) aborts a run via its `AbortSignal`;
providers forward it so in-flight HTTP calls and agent subprocesses actually
stop. Give coding-agent workflows a longer leash (e.g. 45 min).

**Shutdown.** On SIGINT/SIGTERM the daemon stops triggers, drops queued events,
waits up to `defaults.shutdownGraceMs` (default 30 s) for in-flight runs, then
closes. Runs still active when the grace expires are marked `interrupted`. A
second Ctrl+C skips the grace.

**Crash recovery.** On startup the daemon marks runs left `running` by a
crashed process as `interrupted` — no phantom in-progress runs.

**Identity and replay.** Every run captures the workflow file/hash, Steerium
and Node versions, Git SHA/dirty state, and a secret-free config fingerprint.
Replay uses the currently loaded workflow code; compare provenance when output
changes. Workflow/config modules are strictly normalized at startup so typos
and malformed bounds fail early.

**No automatic retries — deliberately.** Agents mutate state (commits,
comments, branches); blind retries duplicate side effects. `steerium replay
<runId>` is the deliberate, manual re-run.

## Control API & browser UI

The daemon serves a localhost control API: `/workflows`, `/runs` (with
`workflow` / `status` / `limit` / `offset` filters and `/runs/count` totals),
`/runs/:id`, `/runs/:id/events`, `/runs/:id/artifacts` (list + download), `GET /approvals` and
`POST /approvals/:id/respond` (pending approvals and the reply path),
`GET /stream` (cursor-resumable append-only run events), `POST /run/:name`,
`POST /replay/:runId`, `POST /runs/:id/cancel`, and
`POST /webhooks/:connector`. The CLI is one client; the UI at
`http://127.0.0.1:4319/` is another — a dashboard, workflow pages with a
fire-with-input form, filterable paginated run history updating live over SSE,
an approvals inbox, and per-run detail with timeline, provenance, step logs,
downloadable artifacts, cancel, and replay.
No workflow editor; it's a thin client, never load-bearing (the prebuilt app
ships in the package; a dependency-free fallback page serves if it's absent).
Disable it with `control.ui: false`.

The API binds to `127.0.0.1` and is unauthenticated locally; exposing it on a
non-local host requires `control.token`. Webhook intake is the one route open
without the token — it's protected by each connector's HMAC signature check
instead, and connectors fail closed when no `webhookSecret` is configured.
Bodies are capped at `control.maxBodyBytes` (1 MiB by default), bearer-token
comparison is timing-safe, and managed config/artifact writes are atomic.

## Extending

Built-ins hold no privileged access — they're written on the same public API a
third-party package would use:

```ts
import { defineProvider, defineTrigger, defineConnector } from "steerium";
```

Custom providers register under `providers` in config; connectors and triggers
are plain exports you import in a workflow file. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the connector recipe.

## Security model

steerium is honest about its trust boundary rather than pretending to sandbox:
workflows run with your OS privileges, like a Makefile or a git hook, and
`steerium project add` is the trust boundary — only register projects you
trust. Coding agents are constrained through their SDK's native
`permissionMode` / `allowedTools`, which is a real, maintained mechanism rather
than a homegrown one. Secrets are env-referenced and redacted from logs.
Vulnerability reports: [SECURITY.md](./SECURITY.md).

## What steerium deliberately is not

No visual builder, no hosted multi-tenant cloud, no thousand-integration
catalog, no policy engine, no durable/resumable execution, no automatic
retries. Some of that is deferred (durable steps, retries with idempotency,
Postgres for server mode), some is philosophy (workflows are code; the core
stays small enough to hold in your head). Approvals deliberately don't bend
this: waiting for a human is persisted state plus a trigger, not a suspended
run.

## Repository layout

This is an npm-workspaces monorepo. What you install from npm is just the
package — the other workspaces exist for development and the website:

| Workspace | What it is |
|---|---|
| [`packages/steerium`](./packages/steerium) | the published npm package: daemon, CLI, triggers, providers |
| [`ui`](./ui) | the browser UI (Vite + Preact); built at publish time and shipped inside the package as static files |
| [`apps/docs`](./apps/docs) | the documentation site (Astro Starlight); deployed to the web, decoupled from npm releases |

```bash
npm install              # installs all workspaces
npm run build            # compile the package
npm test                 # node:test suite (build first)
npm run steerium -- workflow list   # run the CLI from source
npm run ui:dev           # UI dev server (proxies to a running daemon)
npm run docs:dev         # docs site dev server
```

## Contributing

Contributions welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup
and the connector-authoring recipe; connectors are the most wanted
contribution. Security reports go through [SECURITY.md](./SECURITY.md), not
public issues.

## License

[MIT](./LICENSE)
