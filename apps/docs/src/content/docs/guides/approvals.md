---
title: Approvals
description: Human-in-the-loop gates — request a decision, keep working when it arrives.
sidebar:
  order: 3
---

An approval is a question a workflow asks a human — "publish this draft?" —
answered minutes or days later. steerium deliberately has no durable runs, so
nothing blocks waiting: `approvals.request` posts the question and **returns**,
the run ends, and the pending record lives in the store. A second workflow
listens with `approvals.responded()` and fires once per reply. Waiting
survives daemon restarts and holds no concurrency slot.

## Request, then respond

```ts
// draft-post.ts — asks and ends
import { defineWorkflow, schedule, approvals } from "steerium";

export default defineWorkflow({
  name: "draft-post",
  on: schedule.cron("0 9 * * *", { tz: "America/Toronto" }),
  async run(ctx) {
    const date = new Date().toISOString().slice(0, 10);
    const draft = await ctx.step("draft", () =>
      ctx.agent.run({ provider: "claude", prompt: "Write today's blog post…" }),
    );
    await ctx.artifact.writeText("draft.md", draft.text);

    await approvals.request(ctx, {
      id: `blog-${date}`,               // idempotent while pending
      text: `Blog draft for ${date} is ready. Reply "approve" or with feedback.`,
      payload: { draft: draft.text, date },
      ttlMs: 3 * 24 * 60 * 60_000,      // optional: expire after 3 days
    });
  },
});
```

```ts
// handle-reply.ts — fires per human reply
import { defineWorkflow, approvals, isApprove } from "steerium";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

interface BlogPayload { draft: string; date: string }

export default defineWorkflow({
  name: "handle-reply",
  on: approvals.responded<BlogPayload>(),
  async run(ctx) {
    const { type, approval, reply } = ctx.event;
    if (type === "expired") return;     // nobody answered in time

    if (isApprove(reply!.text)) {
      await ctx.step("publish", async () => {
        const file = join(ctx.scope.cwd, "posts", `${approval.payload.date}.md`);
        await writeFile(file, approval.payload.draft);
        await exec("git", ["add", file], { cwd: ctx.scope.cwd, signal: ctx.signal });
        await exec("git", ["commit", "-m", `post: ${approval.payload.date}`], { cwd: ctx.scope.cwd, signal: ctx.signal });
        await exec("git", ["push"], { cwd: ctx.scope.cwd, signal: ctx.signal });
      });
      await approvals.resolve(ctx, approval.id);
    } else {
      const revised = await ctx.step("revise", () =>
        ctx.agent.run({
          provider: "claude",
          prompt: `Revise this draft:\n\n${approval.payload.draft}\n\nFeedback: ${reply!.text}`,
        }),
      );
      await approvals.reask(ctx, {
        id: approval.id,
        text: `Revised draft (round ${approval.rounds + 1}):\n\n${revised.text}`,
        payload: { ...approval.payload, draft: revised.text },  // next round builds on this
      });
    }
  },
});
```

Each round of "feedback → revision → new reply" is just another event — the
revision loop falls out of the event model with no loop construct.

## Answering

Pending approvals are visible at `GET /approvals`, and a reply is one POST —
no external service needed:

```bash
curl -s http://127.0.0.1:4319/approvals | jq
curl -X POST http://127.0.0.1:4319/approvals/blog-2026-07-07/respond \
  -d '{"text": "approve", "requestId": "<from GET /approvals>"}'
```

The `responded()` trigger (a poll trigger, default 10s) turns the reply into
an event, deduped like every connector event. Interpretation is the
workflow's job: `isApprove` accepts only the dumb conventions (`approve`,
`approved`, `lgtm`, `ship it`, a leading 👍); anything richer is one cheap
classify call away.

## The lifecycle

| Call | Effect |
|---|---|
| `approvals.request(ctx, { id, text, payload?, options?, display?, allowFreeform?, via?, ttlMs? })` | create a pending record with a unique `requestId`; idempotent while pending |
| `approvals.reask(ctx, { id, text, payload?, options?, display?, allowFreeform?, via? })` | ask again with a new `requestId`; keeps the logical id/thread and refreshes the TTL |
| `approvals.resolve(ctx, id, decision?)` | close it; further replies stop firing |
| `approvals.get(ctx, id)` | read the record |
| `approvals.responded({ via?, intervalMs? })` | trigger: one event per reply (`type: "responded"`), plus one `type: "expired"` when a TTL lapses |

Records live in the scope-shared kv namespace `"approvals"` (`ctx.kv`), so
the requesting workflow, the responding workflow, and the control API all see
the same state.

## Transports: Slack and friends

By default the request is only visible locally. A **transport** also delivers
it to an external channel and polls that channel for replies — pass it to
both `request` (to send) and `responded` (to fetch):

```ts
import type { ApprovalTransport, ApprovalReply } from "steerium";

export const slackApprovals: ApprovalTransport = {
  kind: "slack",
  /** Post the request; the return value is persisted and handed back on reask. */
  async send(ctx, req) {
    const { botToken, channel } = ctx.connector<{ botToken: string; channel: string }>("slack");
    const state = req.state as { thread?: string } | undefined;
    const ts = await postMessage(botToken, channel, req.text, state?.thread);
    return { thread: state?.thread ?? ts };  // reasks land in the same thread
  },
  /** Poll the thread; reply ids must be stable (Slack's ts is). */
  async fetchReplies(ctx, record): Promise<ApprovalReply[]> {
    const { botToken, channel } = ctx.connector<{ botToken: string; channel: string }>("slack");
    const { thread } = record.transport!.state as { thread: string };
    const msgs = await fetchThread(botToken, channel, thread);
    return msgs
      .filter((m) => !m.bot_id)                       // skip our own posts
      .map((m) => ({ id: m.ts, requestId: record.requestId, text: m.text, user: m.user, at: tsToMs(m.ts), via: "slack" }));
  },
};
```

```ts
await approvals.request(ctx, { id, text, payload, via: slackApprovals });
// ...
on: approvals.responded({ via: slackApprovals }),
```

Replies from the transport and from the control API both count, and both
work at once — approve from Slack on your phone or from the local UI, same
workflow. `postMessage` / `fetchThread` are the ordinary Slack Web API calls
(`chat.postMessage`, `conversations.replies`); see
[custom connectors](/extending/custom-connectors/) for the config and secrets
pattern a transport shares with connectors.

Each reask gets a new `requestId`. A reply carrying an older ID is rejected;
missing IDs are accepted only for first-round compatibility. Set
`allowFreeform: false` with `options: [{ value, label, description? }]` for a
closed choice, and use `display: { kind, content, title? }` for markdown,
code, diffs, or links.

## What approvals are not

Not durable runs. The requesting run really ends; the responding run really
starts fresh. There is no suspended stack frame to resume — which is why an
approval can wait a week on a laptop that sleeps every night, and why
`timeoutMs`, crash recovery, and replay all keep working unchanged.
