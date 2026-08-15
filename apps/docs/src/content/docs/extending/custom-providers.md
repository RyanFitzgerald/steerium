---
title: Custom providers
description: Implement the Provider interface, register it in config, report health to doctor, and wrap the built-ins.
sidebar:
  order: 4
---

A provider turns `ctx.agent.run(opts)` into a real AI call. The interface is
two methods — one required, one for `steerium doctor`:

```ts
interface Provider {
  readonly name: string;
  readonly supportsStructuredOutput?: boolean;
  run(opts: AgentRunOptions, ctx: ProviderContext): Promise<AgentResult>;
  health?(ctx: ProviderContext): ProviderHealth | Promise<ProviderHealth>;
}
```

`run` gets the workflow's options (`prompt`, `system`, `model`, `maxTokens`,
`cwd`, ...) and a context:

| Member | What it is |
|---|---|
| `ctx.signal` | aborts when the owning run times out or is cancelled — **forward it** to your HTTP client or subprocess |
| `ctx.config` | the per-provider settings from config (see below) |
| `ctx.scope` | the run's scope; `scope.cwd` is the repo for project workflows |
| `ctx.logger` | structured logger, already tagged with the provider name |

Return `{ text, raw? }` — `text` is what the workflow reads, `raw` is
whatever provider-specific payload is worth keeping (usage, event streams,
thread ids).

Structured output is opt-in for custom providers. Set
`supportsStructuredOutput: true` only when `run` forwards the JSON Schema and
returns schema-conforming JSON in `text` or parsed `data`. Steerium converts
Standard Schema inputs and validates their result; providers without the flag
fail before making a call.

## A complete provider

A local Ollama provider, in full:

```ts
// ~/.steerium/ollama-provider.ts
import { defineProvider } from "steerium";

export function ollamaProvider(settings: { baseUrl?: string; model?: string } = {}) {
  const base = settings.baseUrl ?? "http://127.0.0.1:11434";

  return defineProvider({
    name: "ollama",

    async run(opts, ctx) {
      const model = opts.model ?? settings.model ?? "llama3.1";
      const res = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          prompt: opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt,
          stream: false,
        }),
        signal: ctx.signal,   // run timeout/cancel stops the request
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { response: string };
      ctx.logger.info(`ollama: ${model} responded`);
      return { text: json.response, raw: json };
    },

    async health() {
      try {
        const res = await fetch(`${base}/api/tags`);
        if (!res.ok) throw new Error(String(res.status));
        return { ok: true, auth: "local", detail: base };
      } catch {
        return { ok: false, auth: "missing", detail: `no ollama at ${base}` };
      }
    },
  });
}
```

## Registering it

An entry in `providers` is either **settings for an existing provider name**
(the built-ins) or **a Provider object**, which registers it under that key:

```ts
// ~/.steerium/config.ts
import { defineConfig } from "steerium";
import { ollamaProvider } from "./ollama-provider.js";

export default defineConfig({
  providers: {
    anthropic: { apiKey: { env: "ANTHROPIC_API_KEY" } },  // settings for a built-in
    ollama: ollamaProvider({ model: "llama3.1" }),        // a new provider
  },
  defaults: { provider: "ollama" },                       // optional: make it the default
});
```

Workflows use it like any other:

```ts
const draft = await ctx.agent.run({ provider: "ollama", prompt: "..." });
```

Note the asymmetry: because a custom provider *is* the config entry, its
settings travel with it — pass them to the factory, as above. `ctx.config`
is populated from config for built-in names; for a provider registered as an
object it's empty, so don't rely on it there.

Registering an object under a built-in name (`openai`, `claude`, ...)
**replaces** that built-in — useful for routing every `provider: "openai"`
call through a proxy without touching workflows.

## Secrets

If your provider needs a key, follow the built-ins: read an env var, never a
literal in config. The simplest correct version:

```ts
const apiKey = process.env.MY_PROVIDER_KEY;
if (!apiKey) throw new Error("my-provider: set MY_PROVIDER_KEY");
```

Throw a clear message naming the variable — that error surfaces in the run
record and in `steerium doctor` (via `health()`), which is where people look
first.

## Wrapping built-ins

The built-in providers are exported (`mockProvider`, `openaiProvider`,
`anthropicProvider`, `codexProvider`, `claudeProvider`), so composition is a
function call. A fallback provider:

```ts
import { anthropicProvider, defineProvider, openaiProvider } from "steerium";

export const resilient = defineProvider({
  name: "resilient",
  async run(opts, ctx) {
    try {
      return await anthropicProvider.run(opts, ctx);
    } catch (err) {
      ctx.logger.warn(`anthropic failed, falling back to openai: ${String(err)}`);
      return openaiProvider.run(opts, ctx);
    }
  },
});
```

Both delegates resolve auth from their standard env vars
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) when the passed-through config has
no `apiKey`. The same shape covers prompt logging, response caching, or cost
guards — wrap `run`, delegate, and register under whatever name workflows
should ask for.

## What providers should *not* do

Keep retries out of providers. steerium deliberately has no automatic
retries at the run level — agents mutate state, and blind retries duplicate
side effects. A provider that silently retries a coding-agent call
reintroduces exactly that hazard one layer down. Fail loudly; `steerium
replay <runId>` is the deliberate re-run.
