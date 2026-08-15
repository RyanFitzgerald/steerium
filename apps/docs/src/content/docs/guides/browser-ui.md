---
title: The browser UI
description: The daemon's built-in web UI — dashboard, live runs, artifacts.
sidebar:
  order: 6
---

`steerium start` serves a browser UI at **http://127.0.0.1:4319/**. It is a
thin client of the same control API the CLI uses — no workflow editor, never
load-bearing. Disable it with `control.ui: false`.

## Dashboard

Daemon status at a glance: workflows loaded, run counts by status, uptime and
scope, registered projects (with a flag for paths that no longer exist), and
the most recent runs, updating live.

## Workflows

Every loaded workflow with its trigger, scope, and tags. Each workflow has a
detail page with its run history and a **fire manually** form — paste JSON
and it arrives in the workflow as `ctx.event.input`, exactly like
`steerium workflow run <name> --input '<json>'`.

## Runs

Filterable, paginated run history — by workflow and every lifecycle outcome,
25–500 per page. The list updates from the resumable run-event stream.

## Run detail

One page per run:

- **Steps** with status, duration, JSON output, and captured logs —
  live-updating while an agent works, so long runs can be watched.
- **Artifacts** the run wrote, listed with size and modified time, each
  downloadable directly.
- **The triggering event**, exactly as persisted — what `replay` will re-run
  against.
- **Provenance** (workflow/config hashes, runtime and Git identity) and a typed
  **timeline** from queueing through steps, agent calls, artifacts and outcome.
- **Cancel** for an executing run (same abort path as a timeout), or
  **replay** for a settled one.

## Approvals

The approvals page shows pending and settled requests. Structured options are
buttons, rich display content is shown with the request, and free-form input
appears only when the workflow allows it. Replies include the current
`requestId`, so an old browser or delayed external response cannot answer a
newer reask round.

## Security

The UI is served by the control API, which binds to `127.0.0.1` and is
unauthenticated locally. Exposing it on a non-local host requires
`control.token`; without one, non-local connections are refused. See
[Control API](/reference/control-api/) for details.
