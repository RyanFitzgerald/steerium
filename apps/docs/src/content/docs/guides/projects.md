---
title: Projects & scopes
description: Global vs. per-project workflows, config merging, and project-scoped mode.
sidebar:
  order: 5
---

Workflows live at two levels, and project config overrides global:

- **Global** — `~/.steerium/workflows/`, runs with `cwd = ~/.steerium`. Shared
  automation (daily content, housekeeping).
- **Project** — `<repo>/.steerium/workflows/`, runs with `cwd = the repo`.
  This is what makes coding-agent workflows natural: the agent operates in the
  actual checkout.

## Registering a project

```bash
steerium project add ~/code/my-app     # registers + scaffolds .steerium/
steerium project list
steerium project remove ~/code/my-app
```

A globally running daemon reads the project registry **at startup**. If
`steerium start` is already running, restart it after `project add`, then
confirm the pickup with `steerium status` — it lists every project the daemon
loaded and flags any registered after it started.

## Config merging

Global config lives in `~/.steerium/config.ts`; per-project
`.steerium/config.ts` merges over it (project wins). A project can override
the default provider, add connectors, or pin its own control port:

```ts
// ~/code/my-app/.steerium/config.ts — merged over global config
import { defineConfig } from "steerium";

export default defineConfig({
  connectors: { linear: { apiKey: { env: "LINEAR_API_KEY" } } },
});
```

## Project-scoped mode

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
`replay` see runs from either mode. Global workflows don't run in project
mode.

## Moving to a new machine

The whole config layer is files, so it ports as one bundle:

```bash
steerium config export --out steerium-config.json   # on the old machine
steerium config import steerium-config.json         # on the new one
```

The bundle contains global `config.ts`, everything under
`~/.steerium/workflows/`, and the project registry. Run history and
credentials deliberately don't travel: state is machine-local, and secrets are
env references, so the bundle never contains a key. Set the same env vars on
the new machine and run `steerium doctor` to confirm everything resolved.
