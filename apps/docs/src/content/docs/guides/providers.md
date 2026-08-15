---
title: Providers
description: API providers, coding-agent providers, and how auth resolves.
sidebar:
  order: 4
---

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
already did. All provider packages load lazily, so the core installs and runs
(with `mock`) without any of them.

One default to know about: without a `permissionMode`, agent providers run
**read-only** — Codex stays in its read-only sandbox, and Claude's `"default"`
mode can't approve tool prompts in a headless run. Set
`permissionMode: "acceptEdits"` (per call or in provider config) for workflows
that should edit files; steerium logs a warning when a run relies on the
read-only default.

## Choosing per call

```ts
const plan = await ctx.agent.run({
  provider: "openai",              // an API call
  prompt: "Plan the change",
});

await ctx.agent.run({
  provider: "claude",              // a real coding agent, in this repo
  permissionMode: "acceptEdits",
  allowedTools: ["Read", "Edit", "Bash"],
  prompt: `Implement:\n\n${plan.text}`,
});
```

Agent-provider options: `permissionMode` (`default` | `acceptEdits` |
`bypassPermissions`), `allowedTools`, `outputSchema`, `cwd`. For project
workflows, `cwd` defaults to the repo root.

`outputSchema` accepts plain JSON Schema or a structural Standard Schema value
and returns parsed data as `AgentResult<T>.data`. It is supported by OpenAI,
Anthropic, Codex, and Claude; the deterministic mock intentionally rejects it.

## Configuration

```ts
import { defineConfig } from "steerium";

export default defineConfig({
  defaults: { provider: "anthropic" },
  providers: {
    anthropic: { apiKey: { env: "ANTHROPIC_API_KEY" }, model: "claude-sonnet-5" },
  },
});
```

Secrets are env references (`{ env: "NAME" }`), never literals, and are
redacted from logs.

## Custom providers

```ts
import { defineConfig, defineProvider } from "steerium";

const echo = defineProvider({
  name: "echo",
  async run(opts) {
    return { text: `ECHO: ${opts.prompt}` };
  },
});

export default defineConfig({ providers: { echo } });
```

A provider may also implement `health()` so `steerium doctor` can report how
its auth resolved. The full guide — registration, secrets, wrapping the
built-ins — is at [custom providers](/extending/custom-providers/).
