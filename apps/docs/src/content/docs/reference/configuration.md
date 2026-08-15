---
title: Configuration
description: Every defineConfig option.
sidebar:
  order: 3
---

Global config lives in `~/.steerium/config.ts`; per-project
`.steerium/config.ts` merges over it (project wins). Config is TypeScript,
loaded at runtime — no build step.

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

## Options

### `defaults`

| Key | Default | Meaning |
|---|---|---|
| `provider` | `mock` | provider used when a call doesn't name one |
| `concurrency` | `1` | simultaneous runs per workflow per scope |
| `timeoutMs` | `300000` (5 min) | run timeout; aborts via `AbortSignal` |
| `queue` | `10` | events waiting per workflow at the concurrency cap; `0` = drop on overlap |
| `shutdownGraceMs` | `30000` | how long shutdown waits for in-flight runs |

Workflow-level `concurrency`, `timeoutMs`, and `queue` override these.

### `providers`

Keyed by provider name. Each entry is either settings for a built-in
(`model`, `apiKey`, `permissionMode`, `allowedTools`, plus provider-specific
keys) or a full custom provider from `defineProvider`.

### `connectors`

Per-connector secrets and settings (e.g. `linear.apiKey`,
`github.token`, `webhookSecret`). Read by connector triggers and by
`ctx.connector(name)` in workflows.

### `projects`

Project roots to load (managed by `steerium project add/remove` — normally
you don't edit this by hand).

### `control`

| Key | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | control API bind address |
| `port` | `4319` | control API port |
| `token` | — | required for non-local binds; `Authorization: Bearer` |
| `ui` | `true` | serve the browser UI at `/` |
| `maxBodyBytes` | `1048576` | maximum JSON/webhook request body size |

Config and workflow modules are normalized strictly at load time. Unknown
top-level/default/control fields, invalid numeric bounds, duplicate workflow
names in one scope, and malformed triggers fail startup with the file and
field in the error. `defineConfig` and `defineWorkflow` remain pass-through
helpers, so there is no hidden mutation after import.

## Secrets

Secrets are env references, never literals:

```ts
apiKey: { env: "ANTHROPIC_API_KEY" }
```

They resolve at call time and are redacted from logs. This is also why
`steerium config export` bundles are safe to move between machines — the
bundle never contains a key.
