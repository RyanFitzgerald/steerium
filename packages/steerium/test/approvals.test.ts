import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  type ApprovalContext,
  type ApprovalEvent,
  type ApprovalTransport,
  appendReply,
  approvals,
  isApprove,
} from "../src/approvals.js";
import { globalScope } from "../src/scope.js";
import type { KeyValueState, TriggerContext } from "../src/types.js";
import { delay, memState as memKv, recordingLogger } from "./helpers.js";

/** Both sides of the handoff share the same kv namespace, like one scope does. */
function contexts(kv: KeyValueState): {
  wctx: ApprovalContext;
  tctx: TriggerContext;
} {
  const scope = globalScope("/tmp");
  const logger = recordingLogger();
  return {
    wctx: { scope, logger, kv: () => kv, connector: () => ({}) as never },
    tctx: {
      scope,
      logger,
      state: memKv(),
      kv: () => kv,
      connector: () => ({}) as never,
      registerWebhook: () => {},
    },
  };
}

test("request is idempotent while pending and sends via the transport once", async () => {
  const kv = memKv();
  const { wctx } = contexts(kv);
  let sends = 0;
  const transport: ApprovalTransport = {
    kind: "fake",
    async send() {
      sends += 1;
      return { thread: "t1" };
    },
  };

  const first = await approvals.request(wctx, {
    id: "post-1",
    text: "Publish?",
    payload: { draft: "d.md" },
    via: transport,
  });
  const second = await approvals.request(wctx, {
    id: "post-1",
    text: "Publish?",
    via: transport,
  });

  assert.equal(sends, 1, "a pending request must not re-send");
  assert.equal(second.requestedAt, first.requestedAt);
  assert.deepEqual(first.transport, { kind: "fake", state: { thread: "t1" } });
  assert.deepEqual((await approvals.get(wctx, "post-1"))?.payload, {
    draft: "d.md",
  });
});

test("responded emits one event per reply; resolve stops further events", async () => {
  const kv = memKv();
  const { wctx, tctx } = contexts(kv);
  await approvals.request(wctx, { id: "post-1", text: "Publish?" });

  // Simulate the control API recording a human reply.
  const record = (await approvals.get(wctx, "post-1"))!;
  await kv.set("post-1", appendReply(record, "please shorten it", "ryan"));

  const events: ApprovalEvent[] = [];
  const handle = await approvals.responded({ intervalMs: 10 }).start(tctx, (e) => {
    events.push(e);
  });
  await delay(50);

  assert.equal(events.length, 1, "one reply → one event, deduped across ticks");
  assert.equal(events[0]!.type, "responded");
  assert.equal(events[0]!.reply?.text, "please shorten it");
  assert.equal(events[0]!.reply?.user, "ryan");

  await approvals.resolve(wctx, "post-1", "approved");
  // A reply landing on a settled approval must not fire.
  const settled = (await approvals.get(wctx, "post-1"))!;
  await kv.set("post-1", appendReply(settled, "late"));
  await delay(40);
  await handle.stop();

  assert.equal(events.length, 1);
  assert.equal((await approvals.get(wctx, "post-1"))?.resolution?.decision, "approved");
});

test("reask bumps rounds, reuses transport state, and refreshes the TTL", async () => {
  const kv = memKv();
  const { wctx } = contexts(kv);
  const sent: Array<{ rounds: number; state?: unknown }> = [];
  const transport: ApprovalTransport = {
    kind: "fake",
    async send(_ctx, req) {
      sent.push({ rounds: req.rounds, state: req.state });
      return { thread: "t1" };
    },
  };

  await approvals.request(wctx, {
    id: "post-1",
    text: "v1",
    payload: { draft: "one" },
    via: transport,
    ttlMs: 60_000,
  });
  const before = (await approvals.get(wctx, "post-1"))!;
  await delay(5);
  const after = await approvals.reask(wctx, {
    id: "post-1",
    text: "v2",
    payload: { draft: "two" },
    via: transport,
  });

  assert.equal(after.rounds, 2);
  assert.notEqual(after.requestId, before.requestId, "each round gets a unique request id");
  assert.equal(after.text, "v2");
  assert.deepEqual(after.payload, { draft: "two" }, "reask carries the revised payload forward");
  assert.deepEqual(sent, [
    { rounds: 1, state: undefined },
    { rounds: 2, state: { thread: "t1" } },
  ]);
  assert.ok(after.expiresAt! > before.expiresAt!, "reask refreshes expiry");
});

test("a TTL'd approval expires once, with an expired event", async () => {
  const kv = memKv();
  const { wctx, tctx } = contexts(kv);
  await approvals.request(wctx, { id: "post-1", text: "Publish?", ttlMs: 20 });

  const events: ApprovalEvent[] = [];
  const handle = await approvals.responded({ intervalMs: 10 }).start(tctx, (e) => {
    events.push(e);
  });
  await delay(80);
  await handle.stop();

  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "expired");
  assert.equal((await approvals.get(wctx, "post-1"))?.status, "expired");
});

test("transport replies are polled only for records of the matching kind", async () => {
  const kv = memKv();
  const { wctx, tctx } = contexts(kv);
  const slackish: ApprovalTransport = {
    kind: "slack",
    async send() {
      return { thread: "t1" };
    },
    async fetchReplies(_ctx, record) {
      return [{
        id: `${record.id}:r1`,
        requestId: record.requestId,
        text: "lgtm",
        at: Date.now(),
        via: "slack",
      }];
    },
  };
  await approvals.request(wctx, {
    id: "slack-1",
    text: "Publish?",
    via: slackish,
  });
  await approvals.request(wctx, { id: "local-1", text: "Publish?" });

  const events: ApprovalEvent[] = [];
  const handle = await approvals.responded({ via: slackish, intervalMs: 10 }).start(tctx, (e) => {
    events.push(e);
  });
  await delay(50);
  await handle.stop();

  assert.equal(events.length, 1, "only the slack-backed record has replies to fetch");
  assert.equal(events[0]!.approval.id, "slack-1");
  assert.equal(events[0]!.reply?.via, "slack");
});

test("isApprove accepts the documented conventions and nothing fancier", () => {
  for (const yes of ["approve", "Approved!", "LGTM", "ship it", "shipit", "👍", "👍 nice"]) {
    assert.equal(isApprove(yes), true, yes);
  }
  for (const no of ["approve but shorten the intro", "yes", "no", "needs work", "lgtm-ish"]) {
    assert.equal(isApprove(no), false, no);
  }
});
