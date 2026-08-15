import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { type GithubIssueEvent, type GithubPullRequestEvent, github } from "../src/index.js";
import type { WebhookRequest } from "../src/types.js";
import { fakeTriggerCtx as fakeCtx, webhookRequest } from "./helpers.js";

function signed(secret: string, body: unknown, ghEvent: string): WebhookRequest {
  const rawBody = JSON.stringify(body);
  const sig = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return webhookRequest({
    headers: { "x-hub-signature-256": sig, "x-github-event": ghEvent },
    rawBody,
  });
}

const PR_PAYLOAD = {
  action: "opened",
  repository: { full_name: "acme/app" },
  pull_request: {
    id: 1,
    number: 42,
    title: "Add feature",
    body: "desc",
    state: "open",
    html_url: "https://github.com/acme/app/pull/42",
    user: { login: "octocat" },
    head: { ref: "feat" },
    base: { ref: "main" },
  },
};

test("github.prOpened webhook: verifies signature and emits a normalized event", async () => {
  const { ctx, getHandler } = fakeCtx({
    webhook: true,
    webhookSecret: "s3cret",
  });
  const emitted: GithubPullRequestEvent[] = [];
  const trigger = github.prOpened({ repo: "acme/app" });
  await trigger.start(ctx, (e) => void emitted.push(e));
  const handler = getHandler();
  assert.ok(handler, "webhook mode must register a handler");

  // Bad signature is rejected and emits nothing.
  const bad = await handler!({
    ...signed("wrong", PR_PAYLOAD, "pull_request"),
  });
  assert.equal(bad.status, 401);
  assert.equal(emitted.length, 0);

  // Valid signature emits the normalized event with a dedupe key.
  const ok = await handler!(signed("s3cret", PR_PAYLOAD, "pull_request"));
  assert.equal(ok.status, 200);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.pr.number, 42);
  assert.equal(emitted[0]!.pr.branch, "feat");
  assert.equal(emitted[0]!.dedupeKey, "github:acme/app#42:prOpened");
});

test("github webhook fails closed without a webhookSecret", async () => {
  const { ctx, getHandler } = fakeCtx({ webhook: true });
  const trigger = github.prOpened({ repo: "acme/app" });
  await trigger.start(ctx, () => {});
  const res = await getHandler()!(signed("anything", PR_PAYLOAD, "pull_request"));
  assert.equal(res.status, 401);
});

test("github.issueOpened webhook: label filter gates opened and labeled actions", async () => {
  const { ctx, getHandler } = fakeCtx({ webhook: true, webhookSecret: "s" });
  const emitted: GithubIssueEvent[] = [];
  const trigger = github.issueOpened({ repo: "acme/app", labels: ["agent"] });
  await trigger.start(ctx, (e) => void emitted.push(e));
  const handler = getHandler()!;

  const issue = {
    id: 2,
    number: 7,
    title: "Do the thing",
    body: "",
    state: "open",
    html_url: "https://github.com/acme/app/issues/7",
    labels: [] as Array<{ name: string }>,
    user: { login: "octocat" },
  };
  const repo = { full_name: "acme/app" };

  // Opened without the label: filtered out.
  await handler(signed("s", { action: "opened", repository: repo, issue }, "issues"));
  assert.equal(emitted.length, 0);

  // Matching label added later: fires.
  await handler(
    signed("s", { action: "labeled", label: { name: "agent" }, repository: repo, issue }, "issues"),
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.issue.number, 7);
});
