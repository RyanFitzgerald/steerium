---
title: Triggers
description: Cron schedules, intervals, ticket events, webhooks, and custom triggers.
sidebar:
  order: 2
---

Every trigger implements one interface. Built-ins:

| Trigger | Fires on |
|---|---|
| `manual()` | `steerium workflow run <name>`, the UI, or the control API |
| `schedule.cron(expr, { tz })` | a cron schedule (via `croner`) |
| `approvals.responded({ via? })` | a human reply to a pending [approval](/guides/approvals/) |
| `schedule.every(ms)` | a fixed interval |
| `linear.ticketMoved({ to, intervalMs? })` | a Linear issue entering a state |
| `jira.issueTransitioned({ to, jql?, intervalMs? })` | a Jira issue transition |
| `github.issueOpened({ repo, labels?, intervalMs? })` | a new GitHub issue (optionally label-filtered) |
| `github.prOpened({ repo, intervalMs? })` | a new GitHub pull request |

## Polling vs. webhooks

Connector triggers poll by default. Polling dedupes through a persistent
cursor, so an issue fires once even across daemon restarts.

With a public URL, the same trigger switches to signature-verified webhooks
via config — the workflow doesn't change. Webhook intake
(`POST /webhooks/<connector>`) is the one control API route open without a
token; it's protected by each connector's HMAC signature check instead, and
connectors fail closed when no `webhookSecret` is configured.

## A ticket-driven example

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
        prompt: `One-line summary of ${ticket.identifier}: ${ticket.title}`,
      }),
    );
    await linear.comment(ctx.connector("linear").apiKey, ticket.id, summary.text);
  },
});
```

Configure the connector once, in config (secrets are env references, never
literals):

```ts
import { defineConfig } from "steerium";

export default defineConfig({
  connectors: { linear: { apiKey: { env: "LINEAR_API_KEY" } } },
});
```

## Dedup

Events are persisted and deduped per `(workflow, scope)` before a run is
created, so two workflows listening to the same connector both fire, but one
workflow never runs twice for the same ticket transition. Replays bypass dedup
deliberately.

## Custom triggers

Custom triggers are first-class: implement `start(ctx, emit)` and you get
persistent state for dedup cursors and webhook registration for free.

```ts
import { defineTrigger } from "steerium";
```

The built-in Linear connector (~170 lines) is the reference implementation —
built-ins hold no privileged access and are written on the same public API a
third-party package would use. The full guide, including the `pollTrigger`
helper and webhook intake, is at
[custom triggers](/extending/custom-triggers/); for packaging triggers and
actions together, see [custom connectors](/extending/custom-connectors/).
