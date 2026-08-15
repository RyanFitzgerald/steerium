---
title: Getting started
description: Install steerium, run your first workflow, and start the daemon.
sidebar:
  order: 1
---

## Start with an agent

steerium publishes an [agent-readable `llms.txt`](/llms.txt) with the essential
setup facts and a curated map of the documentation. Give Claude Code, Codex, or
another coding agent this prompt:

```text
Read https://steerium.dev/llms.txt first. Then help me install steerium and
create a workflow that <describe what should happen and when>. Start with the
mock provider, run the workflow once, and inspect the run record before wiring
up real credentials or side effects.
```

The file lives at a stable URL, so an agent can fetch the current instructions
without requiring the full documentation site in its context window.

## Install

steerium requires Node **>= 22.13**.

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

With the daemon running, open **http://127.0.0.1:4319/** for the browser UI:
a dashboard, workflow list with "run now", filterable run history with live
updates, and per-run detail with step logs and artifacts.

Your workflows and config are TypeScript loaded at runtime — you never build
them. When you're ready for real providers, set an API key (or have the
`claude`/`codex` CLI installed) and run `steerium doctor` to see what resolved.

## Using your local Claude Code or Codex

Already have the `claude` or `codex` CLI installed and logged in? Then there's
nothing to authenticate — the `claude`/`codex` providers drive that same CLI
and inherit its login. Three steps:

1. **Have the CLI installed and logged in** — the same setup you use
   interactively.
2. **Point a workflow at it** — `provider: "claude"` (or `"codex"`) in an
   `agent.run` call, or set `defaults: { provider: "claude" }` in
   `~/.steerium/config.ts`. The scaffolded default is `mock`, so nothing hits
   a real agent until you do.
3. **Allow edits if the workflow should edit files** — without a
   `permissionMode`, agent providers run read-only (there's nobody around to
   approve tool prompts in a headless run):

   ```ts
   providers: {
     claude: { permissionMode: "acceptEdits", allowedTools: ["Read", "Edit", "Bash"] },
     codex: { permissionMode: "acceptEdits" },
   },
   ```

`steerium doctor` verifies the wiring: it reports whether each agent provider
found its SDK, a CLI on your PATH, or nothing.

## Your first real workflow

Create `~/.steerium/workflows/daily-blog.ts`:

```ts
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

Then configure the provider in `~/.steerium/config.ts`:

```ts
import { defineConfig } from "steerium";

export default defineConfig({
  defaults: { provider: "anthropic" },
  providers: {
    anthropic: { apiKey: { env: "ANTHROPIC_API_KEY" } },
  },
});
```

`steerium start` registers the cron; each firing is a recorded, replayable run.

## How it works

Three primitives, one loop:

| Primitive | What it is | Built-ins |
|---|---|---|
| **Trigger** | emits events | cron, interval, Linear/Jira/GitHub poll or webhook, manual |
| **Workflow** | an async TypeScript function handling one event | yours |
| **Provider** | executes an AI or agent call | `openai`, `anthropic`, `codex`, `claude`, `mock` |

An event arrives → it's deduped and persisted → a run row is created → your
function executes (steps and artifacts recorded) → the run is marked ok or
error. The daemon keeps triggers live; a localhost control API serves the CLI
and the browser UI.

## Next steps

- [Writing workflows](/guides/workflows/) — the workflow context in depth
- [Triggers](/guides/triggers/) — cron, polling, webhooks, custom triggers
- [Providers](/guides/providers/) — API keys vs. coding-agent subscriptions
- [Projects & scopes](/guides/projects/) — per-repo workflows and config

Ready to go past the built-ins? **Build your own** covers
[advanced workflow patterns](/extending/advanced-workflows/),
[custom triggers](/extending/custom-triggers/),
[connectors](/extending/custom-connectors/), and
[providers](/extending/custom-providers/).
