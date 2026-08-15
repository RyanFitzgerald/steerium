import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";
import { freshHomeWithControl, startedDaemon, waitFor, writeWorkflow } from "./helpers.js";

const api = (port: number, path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${port}${path}`, init);

test("GET /runs filters by workflow and status; /runs/count matches", async () => {
  const { home, port } = await freshHomeWithControl();
  writeWorkflow(
    home,
    "good",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "good", on: manual(), async run() {} });`,
  );
  writeWorkflow(
    home,
    "bad",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "bad", on: manual(),
       async run() { throw new Error("boom"); } });`,
  );
  const d = await startedDaemon();
  await d.fire("good", { source: "manual" });
  await d.fire("good", { source: "manual" });
  await d.fire("bad", { source: "manual" });

  const all = (await (await api(port, "/runs")).json()) as { status: string }[];
  assert.equal(all.length, 3);

  const errors = (await (await api(port, "/runs?status=failed")).json()) as {
    status: string;
  }[];
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.status, "failed");

  const good = (await (await api(port, "/runs?workflow=good&status=ok")).json()) as unknown[];
  assert.equal(good.length, 2);

  const paged = (await (await api(port, "/runs?limit=1&offset=1")).json()) as unknown[];
  assert.equal(paged.length, 1);

  const count = (await (await api(port, "/runs/count?workflow=good")).json()) as { total: number };
  assert.equal(count.total, 2);
  await d.shutdown();
});

test("artifacts are listed and downloadable; traversal is refused", async () => {
  const { home, port } = await freshHomeWithControl();
  writeWorkflow(
    home,
    "art",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "art", on: manual(),
       async run(ctx) { await ctx.artifact.writeText("out/note.txt", "hello artifacts"); } });`,
  );
  const d = await startedDaemon();
  const res = await d.fire("art", { source: "manual" });
  assert.equal(res.status, "ok", res.error);

  const list = (await (await api(port, `/runs/${res.runId}/artifacts`)).json()) as {
    path: string;
    size: number;
  }[];
  assert.equal(list.length, 1);
  assert.equal(list[0]!.path, join("out", "note.txt"));
  assert.equal(list[0]!.size, "hello artifacts".length);

  const file = await api(port, `/runs/${res.runId}/artifacts/out/note.txt`);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), "hello artifacts");

  const traversal = await api(port, `/runs/${res.runId}/artifacts/..%2F..%2Fconfig.ts`);
  assert.equal(traversal.status, 404, "path traversal must not leave the run dir");

  const none = (await (await api(port, "/runs/nope/artifacts")).json()) as unknown[];
  assert.deepEqual(none, []);
  await d.shutdown();
});

test("POST /runs/:id/cancel aborts an executing run", async () => {
  const { home, port } = await freshHomeWithControl();
  writeWorkflow(
    home,
    "slow",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "slow", on: manual(), timeoutMs: 60000,
       async run(ctx) {
         await new Promise((resolve, reject) => {
           const t = setTimeout(resolve, 5000);
           ctx.signal.addEventListener("abort", () => { clearTimeout(t); reject(ctx.signal.reason); });
         });
       } });`,
  );
  const d = await startedDaemon();
  const firing = d.fire("slow", { source: "manual" });

  // Wait for the run row to exist, then cancel it over the API.
  const runId = await waitFor(
    () => d.getStore().listRuns({ workflow: "slow", status: "running" })[0]?.id,
    { message: "the slow run to start executing" },
  );

  const res = await api(port, `/runs/${runId}/cancel`, { method: "POST" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { cancelled: true });

  const outcome = await firing;
  assert.equal(outcome.status, "cancelled");
  assert.match(outcome.error ?? "", /cancelled/);

  // A settled run can no longer be cancelled.
  const again = await api(port, `/runs/${runId}/cancel`, { method: "POST" });
  assert.equal(again.status, 409);
  await d.shutdown();
});

test("GET /stream replays append-only events with an SSE cursor", async () => {
  const { home, port } = await freshHomeWithControl();
  writeWorkflow(
    home,
    "one",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "one", on: manual(), async run() {} });`,
  );
  const d = await startedDaemon();
  await d.fire("one", { source: "manual" });

  const res = await api(port, "/stream");
  assert.equal(res.headers.get("content-type"), "text/event-stream");
  const reader = res.body!.getReader();
  let buf = "";
  while (!buf.includes("\n\n") || !buf.includes("event: run-event")) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
  }
  const data = buf.split("\n").find((l) => l.startsWith("data: "))!;
  const payload = JSON.parse(data.slice("data: ".length)) as {
    seq: number;
    run_id: string;
    type: string;
  };
  assert.ok(payload.seq > 0);
  assert.match(payload.type, /^run\./);
  assert.match(buf, new RegExp(`id: ${payload.seq}`));

  const timeline = (await (await api(port, `/runs/${payload.run_id}/events`)).json()) as {
    seq: number;
  }[];
  assert.ok(timeline.length >= 3);
  const resumed = (await (
    await api(port, `/runs/${payload.run_id}/events?after=${timeline[0]!.seq}`)
  ).json()) as { seq: number }[];
  assert.ok(resumed.every((item) => item.seq > timeline[0]!.seq));
  await reader.cancel();
  await d.shutdown();
});

test("approvals: requested by a workflow, listed and answered over the API", async () => {
  const { home, port } = await freshHomeWithControl();
  writeWorkflow(
    home,
    "ask",
    `import { defineWorkflow, manual, approvals } from "steerium";
     export default defineWorkflow({ name: "ask", on: manual(), async run(ctx) {
       await approvals.request(ctx, { id: "post-1", text: "Publish?", payload: { draft: "d.md" } });
     } });`,
  );
  writeWorkflow(
    home,
    "reask",
    `import { defineWorkflow, manual, approvals } from "steerium";
     export default defineWorkflow({ name: "reask", on: manual(), async run(ctx) {
       await approvals.reask(ctx, { id: "post-1", text: "Publish revision?" });
     } });`,
  );
  writeWorkflow(
    home,
    "settle",
    `import { defineWorkflow, manual, approvals } from "steerium";
     export default defineWorkflow({ name: "settle", on: manual(), async run(ctx) {
       await approvals.resolve(ctx, "post-1", "approved");
     } });`,
  );
  const d = await startedDaemon();
  const fired = await d.fire("ask", { source: "manual" });
  assert.equal(fired.status, "ok", fired.error);

  const listed = (await (await api(port, "/approvals")).json()) as {
    scopeId: string;
    approval: { id: string; requestId: string; status: string; replies: unknown[] };
  }[];
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.scopeId, "global");
  assert.equal(listed[0]!.approval.status, "pending");

  const firstRequestId = listed[0]!.approval.requestId;
  assert.ok(firstRequestId);

  const respond = (text?: string, id = "post-1", requestId?: string) =>
    api(port, `/approvals/${id}/respond`, {
      method: "POST",
      body: JSON.stringify(text === undefined ? {} : { text, requestId }),
    });

  assert.equal((await respond("hi", "nope")).status, 404, "unknown approval");
  assert.equal((await respond()).status, 400, "missing text");

  const ok = await respond("please shorten it");
  assert.equal(ok.status, 200);
  const withReply = (await (await api(port, "/approvals")).json()) as {
    approval: { replies: { text: string; via: string }[] };
  }[];
  assert.equal(withReply[0]!.approval.replies.length, 1);
  assert.equal(withReply[0]!.approval.replies[0]!.text, "please shorten it");
  assert.equal(withReply[0]!.approval.replies[0]!.via, "api");

  await d.fire("reask", { source: "manual" });
  const reasked = (await (await api(port, "/approvals")).json()) as {
    approval: { requestId: string; rounds: number };
  }[];
  const secondRequestId = reasked[0]!.approval.requestId;
  assert.equal(reasked[0]!.approval.rounds, 2);
  assert.notEqual(secondRequestId, firstRequestId);
  assert.equal((await respond("late", "post-1", firstRequestId)).status, 409, "stale round");
  assert.equal((await respond("missing id")).status, 409, "later rounds require requestId");
  assert.equal((await respond("approve", "post-1", secondRequestId)).status, 200);

  const settled = await d.fire("settle", { source: "manual" });
  assert.equal(settled.status, "ok", settled.error);
  assert.equal((await respond("too late")).status, 409, "settled approvals refuse replies");
  await d.shutdown();
});

test("GET / serves the fallback UI when no built SPA is present", async () => {
  await freshHomeWithControl();
  const d = await startedDaemon();
  const res = await fetch(`${d.controlUrl()}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await res.text(), /steerium/);
  await d.shutdown();
});

test("request bodies are bounded and malformed JSON is a client error", async () => {
  const { port } = await freshHomeWithControl();
  const d = await startedDaemon();
  const tooLarge = await api(port, "/run/nope", {
    method: "POST",
    body: JSON.stringify("x".repeat(1024 * 1024)),
  });
  assert.equal(tooLarge.status, 413);
  const invalid = await api(port, "/run/nope", { method: "POST", body: "{" });
  assert.equal(invalid.status, 400);
  await d.shutdown();
});
