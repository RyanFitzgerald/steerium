---
title: Custom connectors
description: Package triggers and actions for one external system, configure its secrets, and share it as an npm package.
sidebar:
  order: 3
---

A connector is a convention, not a framework: one object that packages the
**triggers** (things that fire workflows) and **actions** (things workflows
call back with) for a single external system. `defineConnector` is an
identity helper — the runtime never special-cases connectors, so yours works
exactly like `linear`, `jira`, and `github` do. The built-in
[Linear connector](https://github.com/RyanFitzgerald/steerium/blob/main/packages/steerium/src/connectors/linear.ts)
(~170 lines) is the reference implementation, written entirely on the public
API.

## Configuration and secrets

A connector reads its settings from `connectors.<name>` in config. Secrets
are env references — resolved at access time, redacted from logs, and never
written into config bundles:

```ts
// ~/.steerium/config.ts
import { defineConfig } from "steerium";

export default defineConfig({
  connectors: {
    slack: {
      botToken: { env: "SLACK_BOT_TOKEN" },
    },
  },
});
```

Both sides read the same resolved config: triggers via `ctx.connector(name)`
on the trigger context, workflows via `ctx.connector(name)` on the run
context. By the time you read it, `{ env: "..." }` references are plain
strings.

## A complete connector

Slack, with one trigger and one action:

```ts
// slack-connector.ts
import { defineConnector, pollTrigger } from "steerium";
import type { Trigger } from "steerium";

export interface SlackMessage {
  channel: string;
  ts: string;
  user: string;
  text: string;
}

export interface SlackMessageEvent {
  source: "slack";
  type: "messagePosted";
  message: SlackMessage;
}

interface SlackConfig {
  botToken?: string;
}

async function api<T>(token: string, method: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const json = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!json.ok) throw new Error(`slack ${method}: ${json.error}`);
  return json;
}

export const slack = defineConnector({
  /** Trigger: fires once per new message in a channel. */
  messagePosted(opts: { channel: string; intervalMs?: number }): Trigger<SlackMessageEvent> {
    return pollTrigger<SlackMessageEvent>({
      kind: "slack.messagePosted",
      intervalMs: opts.intervalMs ?? 30_000,
      stateKey: `seen:${opts.channel}`,
      async fetch(ctx) {
        const { botToken } = ctx.connector<SlackConfig>("slack");
        if (!botToken) throw new Error("slack: missing connectors.slack.botToken");
        const data = await api<{ messages: Array<{ ts: string; user?: string; text?: string }> }>(
          botToken,
          "conversations.history",
          { channel: opts.channel, limit: "50" },
        );
        return data.messages.map((m) => ({
          id: `${opts.channel}:${m.ts}`,   // ts is Slack's stable message id
          event: {
            source: "slack",
            type: "messagePosted",
            message: { channel: opts.channel, ts: m.ts, user: m.user ?? "", text: m.text ?? "" },
          },
        }));
      },
    });
  },

  /** Action: post a message to a channel. */
  async post(botToken: string, channel: string, text: string): Promise<void> {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, text }),
    });
    const json = (await res.json()) as { ok: boolean; error?: string };
    if (!json.ok) throw new Error(`slack chat.postMessage: ${json.error}`);
  },
});
```

The shape to copy: trigger factories take options and return a `Trigger<E>`;
actions are plain async functions taking explicit credentials. Actions don't
get a context — the workflow passes the token from `ctx.connector`, which
keeps actions trivially testable.

## Using it in a workflow

```ts
// ~/.steerium/workflows/support-triage.ts
import { defineWorkflow } from "steerium";
import { slack } from "../slack-connector.js";

export default defineWorkflow({
  name: "support-triage",
  on: slack.messagePosted({ channel: "C0123456789" }),
  async run(ctx) {
    const { message } = ctx.event;
    const reply = await ctx.step("draft", () =>
      ctx.agent.run({
        provider: "anthropic",
        prompt: `Draft a one-paragraph first response to:\n\n${message.text}`,
      }),
    );
    const { botToken } = ctx.connector<{ botToken: string }>("slack");
    await ctx.step("post", () => slack.post(botToken, message.channel, reply.text));
  },
});
```

## Adding webhook mode

For laptop use, polling is the right default — no public URL needed. If your
daemon is reachable, wrap the poll trigger so config flips it to webhooks
without touching any workflow. This is the exact pattern the built-ins use:

```ts
messagePosted(opts: { channel: string; intervalMs?: number }): Trigger<SlackMessageEvent> {
  const poll = /* the pollTrigger above */;

  return {
    kind: poll.kind,
    async start(ctx, emit) {
      const c = ctx.connector<SlackConfig & { webhook?: boolean; webhookSecret?: string }>("slack");
      if (!c.webhook) return poll.start(ctx, emit);   // default: poll

      ctx.registerWebhook("/webhooks/slack", async (req) => {
        if (!c.webhookSecret || !verifySignature(c.webhookSecret, req)) {
          return { status: 401, body: "invalid signature" };   // fail closed
        }
        // parse req.rawBody, filter to opts.channel, emit(...)
        return { status: 200, body: "ok" };
      });
      return { stop() {} };
    },
  };
}
```

Two rules the built-ins follow, worth keeping: verify an HMAC signature over
the **raw** body, and refuse everything when no `webhookSecret` is
configured. See [custom triggers](/extending/custom-triggers/#webhook-triggers)
for a full verification example.

## Packaging and sharing

A connector is an ordinary module, so sharing it is ordinary npm. Publish a
package that exports the connector object and its event types:

```ts
// package: steerium-connector-slack
export { slack } from "./connector.js";
export type { SlackMessage, SlackMessageEvent } from "./connector.js";
```

Consumers install it next to their workflows and import it — there is no
registration step, because the trigger lives with the workflow that uses it:

```ts
import { defineWorkflow } from "steerium";
import { slack } from "steerium-connector-slack";

export default defineWorkflow({
  name: "support-triage",
  on: slack.messagePosted({ channel: "C0123456789" }),
  // ...
});
```

Config stays in the consumer's `config.ts` under `connectors.slack`, with
their secrets as env references. Built-ins hold no privileged access, so a
published connector is a first-class citizen — same interface, same context,
same webhook intake.
