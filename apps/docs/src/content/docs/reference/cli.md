---
title: CLI
description: Every steerium command.
sidebar:
  order: 1
---

Single-shot commands work without a running daemon (they act in-process); when
a daemon **is** running they go through its control API.

| Command | What it does |
|---|---|
| `steerium init` | scaffold `~/.steerium/` + starter workflows |
| `steerium project add <path>` | register a project (a running daemon needs a restart to see it) |
| `steerium project list` | list registered projects |
| `steerium project remove <path>` | unregister a project |
| `steerium config export [--out <file>]` | bundle config + workflows + project registry |
| `steerium config import <file> [--force]` | restore a bundle on this machine |
| `steerium start [--project [path]] [--global]` | run the daemon: triggers, control API, browser UI |
| `steerium workflow list` | list registered workflows |
| `steerium workflow run <name> [--input <json>] [--project <path>]` | fire one workflow once |
| `steerium logs [--limit <n>] [--follow]` | recent run history |
| `steerium run <runId>` | show a run's detail + steps |
| `steerium replay <runId>` | re-run a workflow against its stored event |
| `steerium cancel <runId>` | abort an executing run (requires a running daemon) |
| `steerium status` | query a running daemon (scope, projects picked up, workflows) |
| `steerium doctor` | check Node version, provider auth, connector config |

## Notes

- `--input` arrives in the workflow as `ctx.event.input`.
- `steerium start` inside a repo containing `.steerium/` auto-detects project
  scope; `--global` forces the global daemon.
- `steerium cancel` aborts through the run's `AbortSignal` — the same path as
  a timeout — so provider calls and agent subprocesses actually stop.
- `STEERIUM_HOME` overrides the global root (`~/.steerium`) for tests,
  sandboxes, and server deploys.
