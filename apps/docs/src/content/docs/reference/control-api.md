---
title: Control API
description: The daemon's localhost HTTP API — every endpoint.
sidebar:
  order: 2
---

The daemon serves a control API on `http://127.0.0.1:4319` (configurable via
`control.host` / `control.port`). The CLI is one client; the browser UI is
another. It binds to `127.0.0.1` and is unauthenticated locally; exposing it
on a non-local host requires `control.token`, sent as
`Authorization: Bearer <token>`.

## Endpoints

### `GET /health`

`{ "ok": true }` — used by the CLI to detect a running daemon.

### `GET /status`

The daemon's startup snapshot: pid, uptime, mode (`global` | `project`),
registered projects and whether each contributed workflows, and the loaded
workflow count.

### `GET /workflows`

All loaded workflows: `name`, `triggerKind`, `scopeId`, `tags`.

### `GET /runs`

Run history, newest first. Query parameters:

| Param | Meaning |
|---|---|
| `limit` | max rows (default 50) |
| `offset` | pagination offset |
| `workflow` | only this workflow's runs |
| `status` | `queued` \| `running` \| `ok` \| `failed` \| `cancelled` \| `timed_out` \| `interrupted` \| `dropped` |

### `GET /runs/count`

`{ "total": n }` for the same `workflow` / `status` filters — pagination
totals.

### `GET /runs/:id`

One run's detail: `{ run, steps, agentCalls, events }`. The run includes
structured error fields and a `provenance_json` execution identity; events are
the ordered append-only timeline.

### `GET /runs/:id/events`

Typed timeline events for one run. `after=<seq>` resumes after a sequence
cursor; `limit` defaults to 1000.

### `GET /runs/:id/artifacts`

Files the run wrote: `[{ path, size, mtime }]`, paths relative to the run's
artifact directory.

### `GET /runs/:id/artifacts/<path>`

Download one artifact. Paths that escape the run's directory are refused.

### `POST /run/:name`

Fire a workflow once. The JSON body arrives as `ctx.event.input`. Optional
`?project=<root>` resolves duplicate workflow names to the intended scope.
Returns `{ runId, status, error? }` when the run settles.

### `POST /replay/:runId`

Re-run a workflow against the stored event of a previous run. Bypasses dedup
deliberately.

### `POST /runs/:id/cancel`

Abort an executing run via its `AbortSignal` (the same path as a timeout).
`200 { "cancelled": true }`, or `409` if the run isn't currently executing.

### `GET /approvals`

All [approvals](/guides/approvals/) across the daemon's scopes, pending
first, newest first: `[{ scopeId, approval }]`, where `approval` carries
`id`, per-round `requestId`, `status`, request `text`, optional `options` and
`display`, `payload`, `rounds`, `replies`, and timestamps.

### `POST /approvals/:id/respond`

Record a human reply on a pending approval. Body: `{ "text": "...",
"requestId": "...", "user"?, "scopeId"? }` (`scopeId` disambiguates duplicate
ids across scopes). A missing request ID remains compatible for the first
round only; later rounds require it, and stale IDs return `409`. The
`approvals.responded()` trigger turns the reply into an event on its next
poll. `404` for an unknown id, `409` when the approval is already resolved
or expired.

### `GET /stream`

Server-sent events backed by the append-only run-event log. Use `after=<seq>`
(`after=latest` for future events only); reconnects resume from
`Last-Event-ID`:

```
id: 42
event: run-event
data: { "seq": 42, "id": "...", "run_id": "...", "type": "step.completed", "data_json": "..." }
```

The browser UI uses this for live run watching; `curl -N` works too.

### `POST /webhooks/<connector>`

Webhook intake for connector triggers. The one route open without a token —
protected by each connector's HMAC signature verification instead; connectors
fail closed when no `webhookSecret` is configured.

JSON and webhook bodies are capped by `control.maxBodyBytes` (1 MiB by
default). Non-local bearer-token comparison is timing-safe.

## The browser UI

`GET /` serves the UI — the prebuilt app shipped in the package when present,
with a dependency-free fallback page otherwise. Disable with
`control.ui: false`.
