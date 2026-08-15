---
title: Custom triggers
description: The Trigger interface, the pollTrigger helper, webhook intake, and persistent dedup state.
sidebar:
  order: 2
---

A trigger is anything that calls `emit(event)`. The built-ins — cron,
intervals, and every connector trigger — are written on the same two-method
interface you get, with no privileged access:

```ts
import { defineTrigger } from "steerium";

const trigger = defineTrigger<MyEvent>({
  kind: "my-source.something-happened",   // shows up in run records and logs
  async start(ctx, emit) {
    // subscribe to something; call emit(event) when it fires
    return {
      stop() {
        // unsubscribe; called on daemon shutdown
      },
    };
  },
});
```

The event type `E` is yours to define — whatever you `emit` arrives typed as
`ctx.event` in every workflow using the trigger.

## The trigger context

`start(ctx, emit)` receives:

| Member | What it is |
|---|---|
| `ctx.state` | persistent key/value store scoped to this trigger — survives daemon restarts (`get` / `set` / `delete`) |
| `ctx.connector(name)` | resolved connector config from `connectors.<name>` — secrets included |
| `ctx.registerWebhook(path, handler)` | register an HTTP route on the control server |
| `ctx.scope` | where the owning workflow lives; `scope.cwd` is the repo for project workflows |
| `ctx.logger` | structured logger bound to this trigger |

## Polling with `pollTrigger`

Most custom triggers are "ask an API on an interval, fire once per new
thing." `pollTrigger` handles the loop, error logging, and the persistent
seen-set so the same item never fires twice — even across restarts. You
write one `fetch`:

| Field | Meaning |
|---|---|
| `kind` | trigger kind string |
| `intervalMs` | poll interval (first tick after one interval) |
| `fetch(ctx)` | return the current candidates as `{ id, event }[]` — `id` is the stable dedup key |
| `stateKey` | namespace for the seen-id set (default `"seen"`) |
| `maxRemembered` | cap on remembered ids (default 5000) |

A complete example — fire when a dependency publishes a new version:

```ts
// ~/.steerium/workflows/dep-watch.ts
import { defineWorkflow, pollTrigger } from "steerium";

interface NpmReleaseEvent {
  source: "npm";
  pkg: string;
  version: string;
}

function npmRelease(pkg: string, intervalMs = 15 * 60_000) {
  return pollTrigger<NpmReleaseEvent>({
    kind: "npm.release",
    intervalMs,
    stateKey: `seen:${pkg}`,
    async fetch() {
      const res = await fetch(`https://registry.npmjs.org/${pkg}`);
      if (!res.ok) throw new Error(`npm registry ${res.status}`);
      const data = (await res.json()) as { "dist-tags": { latest: string } };
      const version = data["dist-tags"].latest;
      return [{ id: `${pkg}@${version}`, event: { source: "npm", pkg, version } }];
    },
  });
}

export default defineWorkflow({
  name: "dep-watch",
  on: npmRelease("typescript"),
  async run(ctx) {
    const { pkg, version } = ctx.event;   // typed as NpmReleaseEvent
    const notes = await ctx.step("summarize", () =>
      ctx.agent.run({ provider: "anthropic", prompt: `What changed in ${pkg}@${version}?` }),
    );
    await ctx.artifact.writeText("release-notes.md", notes.text);
  },
});
```

A thrown `fetch` is logged and retried next interval — one bad poll doesn't
kill the trigger.

## Webhook triggers

When the daemon has a reachable URL, skip polling: register a route and emit
from the handler. `POST /webhooks/<path>` is the one control-API surface
open without a token, so **verify a signature and fail closed** — every
built-in connector refuses requests when no secret is configured:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineTrigger } from "steerium";
import type { WebhookRequest } from "steerium";

interface DeployEvent {
  source: "deploybot";
  service: string;
  status: "succeeded" | "failed";
}

function verify(secret: string, req: WebhookRequest): boolean {
  const sig = req.headers["x-deploybot-signature"];
  if (!sig) return false;
  const expected = createHmac("sha256", secret).update(req.rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export function deployFinished() {
  return defineTrigger<DeployEvent>({
    kind: "deploybot.finished",
    async start(ctx, emit) {
      const { webhookSecret } = ctx.connector<{ webhookSecret?: string }>("deploybot");
      ctx.registerWebhook("/webhooks/deploybot", async (req) => {
        if (!webhookSecret || !verify(webhookSecret, req)) {
          return { status: 401, body: "invalid signature" };
        }
        const body = JSON.parse(req.rawBody) as { service: string; status: DeployEvent["status"] };
        await emit({ source: "deploybot", service: body.service, status: body.status });
        return { status: 200, body: "ok" };
      });
      return { stop() {} };
    },
  });
}
```

The handler gets `method`, `headers`, `query`, and the **raw** body string —
raw so HMAC verification works before any parsing.

## Dedup beyond the poll cursor

`pollTrigger`'s seen-set stops the same item being *emitted* twice. There is
a second, independent layer: if an emitted event carries a string
`dedupeKey` property, the runtime also dedupes it per `(workflow, scope)`
before creating a run. Set it when the same logical event can reach the
daemon twice — e.g. a webhook retry:

```ts
await emit({
  source: "deploybot",
  service: body.service,
  status: body.status,
  dedupeKey: `deploybot:${body.deployId}`,
});
```

Replays bypass both layers deliberately.

## Cursors beyond a seen-set

`ctx.state` is a general store, not just for `pollTrigger`. A
timestamp-cursor trigger reads and advances its own watermark:

```ts
async start(ctx, emit) {
  const tick = async () => {
    const since = (await ctx.state.get<string>("cursor")) ?? new Date().toISOString();
    const items = await fetchChangesSince(since);
    for (const item of items) await emit(item.event);
    if (items.length > 0) await ctx.state.set("cursor", items.at(-1)!.updatedAt);
  };
  const timer = setInterval(() => void tick(), 60_000);
  return { stop: () => clearInterval(timer) };
}
```

When a trigger with the same `kind` backs several workflows, give each
instance its own `stateKey` (the built-ins namespace by their options — e.g.
`seen:${repo}`), so cursors don't collide.
