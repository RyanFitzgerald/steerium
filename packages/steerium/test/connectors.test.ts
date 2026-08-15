/**
 * Linear and Jira connectors. github.test.ts covers the third; these two prove
 * the connector pattern holds for a GraphQL backend and a REST one, and pin the
 * security-relevant halves: webhooks fail closed, poll mode dedupes per state.
 */
import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { type JiraIssueEvent, jira } from "../src/connectors/jira.js";
import { type LinearTicketEvent, linear } from "../src/connectors/linear.js";
import { fakeTriggerCtx, jsonResponse, waitFor, webhookRequest, withFetch } from "./helpers.js";

// ---- linear -------------------------------------------------------------------

const LINEAR_NODE = {
  id: "iss_1",
  identifier: "ENG-42",
  title: "Fix the thing",
  description: "details",
  updatedAt: "2026-01-01T00:00:00Z",
  state: { name: "Todo" },
};

test("linear.ticketMoved polls the GraphQL API and normalizes issues", async () => {
  const { ctx } = fakeTriggerCtx({ linear: { apiKey: "lin_api_testkey" } });
  const emitted: LinearTicketEvent[] = [];

  await withFetch(
    () => jsonResponse({ data: { issues: { nodes: [LINEAR_NODE] } } }),
    async (calls) => {
      const handle = await linear
        .ticketMoved({ to: "Todo", intervalMs: 15 })
        .start(ctx, (e) => void emitted.push(e));
      await waitFor(() => emitted.length >= 1, {
        message: "a polled linear issue",
      });
      await handle.stop();

      assert.equal(calls[0]!.url, "https://api.linear.app/graphql");
      assert.equal(
        (calls[0]!.init!.headers as Record<string, string>).authorization,
        "lin_api_testkey",
      );
      // The state filter is a bound variable, not string-interpolated into the query.
      const body = JSON.parse(calls[0]!.init!.body as string) as {
        variables: { state: string };
      };
      assert.deepEqual(body.variables, { state: "Todo" });
    },
  );

  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0]!.ticket, {
    id: "iss_1",
    identifier: "ENG-42",
    title: "Fix the thing",
    description: "details",
    status: "Todo",
  });
  assert.equal(emitted[0]!.type, "ticketMoved");
});

test("linear poll dedupes an unchanged issue across ticks", async () => {
  const { ctx } = fakeTriggerCtx({ linear: { apiKey: "k" } });
  const emitted: LinearTicketEvent[] = [];

  await withFetch(
    () => jsonResponse({ data: { issues: { nodes: [LINEAR_NODE] } } }),
    async (calls) => {
      const handle = await linear
        .ticketMoved({ to: "Todo", intervalMs: 10 })
        .start(ctx, (e) => void emitted.push(e));
      await waitFor(() => calls.length >= 3, { message: "three poll ticks" });
      await handle.stop();
    },
  );
  assert.equal(emitted.length, 1, "the same issue in the same state must fire once");
});

test("linear poll surfaces a null description as an empty string, not 'null'", async () => {
  const { ctx } = fakeTriggerCtx({ linear: { apiKey: "k" } });
  const emitted: LinearTicketEvent[] = [];
  await withFetch(
    () =>
      jsonResponse({
        data: { issues: { nodes: [{ ...LINEAR_NODE, description: null }] } },
      }),
    async () => {
      const handle = await linear
        .ticketMoved({ to: "Todo", intervalMs: 10 })
        .start(ctx, (e) => void emitted.push(e));
      await waitFor(() => emitted.length >= 1, { message: "the issue" });
      await handle.stop();
    },
  );
  assert.equal(emitted[0]!.ticket.description, "");
});

test("linear GraphQL errors and HTTP failures both surface as thrown errors", async () => {
  const { ctx, logger } = fakeTriggerCtx({ linear: { apiKey: "k" } });

  await withFetch(
    () => jsonResponse({ errors: [{ message: "bad query" }] }),
    async () => {
      const handle = await linear.ticketMoved({ to: "Todo", intervalMs: 10 }).start(ctx, () => {});
      await waitFor(() => logger.lines.some((l) => l.includes("bad query")), {
        message: "the GraphQL error to be logged",
      });
      await handle.stop();
    },
  );

  const second = fakeTriggerCtx({ linear: { apiKey: "k" } });
  await withFetch(
    () => new Response("nope", { status: 500 }),
    async () => {
      const handle = await linear
        .ticketMoved({ to: "Todo", intervalMs: 10 })
        .start(second.ctx, () => {});
      await waitFor(() => second.logger.lines.some((l) => l.includes("Linear API 500")), {
        message: "the HTTP error to be logged",
      });
      await handle.stop();
    },
  );
});

test("linear poll without an apiKey reports the config it needs", async () => {
  const { ctx, logger } = fakeTriggerCtx({ linear: {} });
  const handle = await linear.ticketMoved({ to: "Todo", intervalMs: 10 }).start(ctx, () => {});
  await waitFor(() => logger.lines.some((l) => l.includes("connectors.linear.apiKey")), {
    message: "the missing-key error",
  });
  await handle.stop();
});

function linearSigned(secret: string, body: unknown) {
  const rawBody = JSON.stringify(body);
  return webhookRequest({
    headers: {
      "linear-signature": createHmac("sha256", secret).update(rawBody).digest("hex"),
    },
    rawBody,
  });
}

const LINEAR_HOOK_BODY = {
  action: "update",
  type: "Issue",
  data: {
    id: "iss_1",
    identifier: "ENG-42",
    title: "Fix the thing",
    description: "details",
    state: { name: "Todo" },
  },
};

test("linear webhook mode verifies the signature and emits on a state match", async () => {
  const { ctx, getHandler, getPath } = fakeTriggerCtx({
    linear: { webhook: true, webhookSecret: "s3cret" },
  });
  const emitted: LinearTicketEvent[] = [];
  await linear.ticketMoved({ to: "Todo" }).start(ctx, (e) => void emitted.push(e));

  const handler = getHandler();
  assert.ok(handler, "webhook mode must register a handler");
  assert.equal(getPath(), "/webhooks/linear");

  // Wrong signature: rejected, nothing emitted.
  assert.equal((await handler!(linearSigned("wrong", LINEAR_HOOK_BODY))).status, 401);
  assert.equal(emitted.length, 0);

  // Missing signature header entirely: also rejected.
  assert.equal(
    (await handler!(webhookRequest({ rawBody: JSON.stringify(LINEAR_HOOK_BODY) }))).status,
    401,
  );
  assert.equal(emitted.length, 0);

  const ok = await handler!(linearSigned("s3cret", LINEAR_HOOK_BODY));
  assert.equal(ok.status, 200);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.ticket.identifier, "ENG-42");
  assert.equal(emitted[0]!.ticket.status, "Todo");
});

test("linear webhook fails closed when no webhookSecret is configured", async () => {
  const { ctx, getHandler } = fakeTriggerCtx({ linear: { webhook: true } });
  const emitted: LinearTicketEvent[] = [];
  await linear.ticketMoved({ to: "Todo" }).start(ctx, (e) => void emitted.push(e));
  // Even a correctly-signed payload must be refused: with no secret there is
  // nothing to verify against, so the only safe answer is no.
  assert.equal((await getHandler()!(linearSigned("any", LINEAR_HOOK_BODY))).status, 401);
  assert.equal(emitted.length, 0);
});

test("linear webhook ignores issues in a different state and non-Issue payloads", async () => {
  const { ctx, getHandler } = fakeTriggerCtx({
    linear: { webhook: true, webhookSecret: "s" },
  });
  const emitted: LinearTicketEvent[] = [];
  await linear.ticketMoved({ to: "Done" }).start(ctx, (e) => void emitted.push(e));
  const handler = getHandler()!;

  assert.equal((await handler(linearSigned("s", LINEAR_HOOK_BODY))).status, 200);
  assert.equal(emitted.length, 0, "state Todo must not fire a trigger watching Done");

  const comment = {
    ...LINEAR_HOOK_BODY,
    type: "Comment",
    data: { ...LINEAR_HOOK_BODY.data, state: { name: "Done" } },
  };
  assert.equal((await handler(linearSigned("s", comment))).status, 200);
  assert.equal(emitted.length, 0, "only Issue payloads are ticketMoved events");
});

test("linear.comment posts a commentCreate mutation for the issue", async () => {
  await withFetch(
    () => jsonResponse({ data: { commentCreate: { success: true } } }),
    async (calls) => {
      await linear.comment("lin_api_k", "iss_1", "on it");
      const body = JSON.parse(calls[0]!.init!.body as string) as {
        query: string;
        variables: Record<string, string>;
      };
      assert.match(body.query, /commentCreate/);
      assert.deepEqual(body.variables, { issueId: "iss_1", body: "on it" });
    },
  );
});

// ---- jira ---------------------------------------------------------------------

const JIRA_ISSUE = {
  id: "10001",
  key: "PROJ-7",
  fields: {
    summary: "Ship it",
    description: "body",
    status: { name: "In Progress" },
    updated: "2026-01-01T00:00:00Z",
  },
};

const JIRA_CFG = {
  host: "https://acme.atlassian.net",
  email: "me@acme.com",
  apiToken: "tok",
};

test("jira.issueTransitioned polls the REST API with a JQL status filter", async () => {
  const { ctx } = fakeTriggerCtx({ jira: JIRA_CFG });
  const emitted: JiraIssueEvent[] = [];

  await withFetch(
    () => jsonResponse({ issues: [JIRA_ISSUE] }),
    async (calls) => {
      const handle = await jira
        .issueTransitioned({ to: "In Progress", intervalMs: 15 })
        .start(ctx, (e) => void emitted.push(e));
      await waitFor(() => emitted.length >= 1, {
        message: "a polled jira issue",
      });
      await handle.stop();

      const url = new URL(calls[0]!.url);
      assert.equal(url.pathname, "/rest/api/3/search");
      assert.equal(url.searchParams.get("jql"), 'status = "In Progress"');
      assert.equal(
        (calls[0]!.init!.headers as Record<string, string>).authorization,
        `Basic ${Buffer.from("me@acme.com:tok").toString("base64")}`,
      );
    },
  );

  assert.deepEqual(emitted[0]!.ticket, {
    id: "10001",
    identifier: "PROJ-7",
    title: "Ship it",
    description: "body",
    status: "In Progress",
  });
});

test("jira ANDs extra JQL onto the status filter", async () => {
  const { ctx } = fakeTriggerCtx({ jira: JIRA_CFG });
  await withFetch(
    () => jsonResponse({ issues: [] }),
    async (calls) => {
      const handle = await jira
        .issueTransitioned({
          to: "Done",
          jql: "project = PROJ",
          intervalMs: 10,
        })
        .start(ctx, () => {});
      await waitFor(() => calls.length >= 1, { message: "a poll tick" });
      await handle.stop();
      assert.equal(
        new URL(calls[0]!.url).searchParams.get("jql"),
        'status = "Done" AND project = PROJ',
      );
    },
  );
});

test("jira maps a non-string (ADF) description to an empty string", async () => {
  // Jira Cloud returns rich-text descriptions as document objects. Stringifying
  // one into a prompt would be noise, so the connector drops it.
  const { ctx } = fakeTriggerCtx({ jira: JIRA_CFG });
  const emitted: JiraIssueEvent[] = [];
  await withFetch(
    () =>
      jsonResponse({
        issues: [
          {
            ...JIRA_ISSUE,
            fields: { ...JIRA_ISSUE.fields, description: { type: "doc" } },
          },
        ],
      }),
    async () => {
      const handle = await jira
        .issueTransitioned({ to: "In Progress", intervalMs: 10 })
        .start(ctx, (e) => void emitted.push(e));
      await waitFor(() => emitted.length >= 1, { message: "the issue" });
      await handle.stop();
    },
  );
  assert.equal(emitted[0]!.ticket.description, "");
});

test("jira poll without host/email/apiToken reports the config it needs", async () => {
  const { ctx, logger } = fakeTriggerCtx({
    jira: { host: "https://acme.atlassian.net" },
  });
  const handle = await jira.issueTransitioned({ to: "Done", intervalMs: 10 }).start(ctx, () => {});
  await waitFor(
    () => logger.lines.some((l) => l.includes("connectors.jira.{host,email,apiToken}")),
    {
      message: "the missing-config error",
    },
  );
  await handle.stop();
});

function jiraSigned(secret: string, body: unknown, header = "x-hub-signature") {
  const rawBody = JSON.stringify(body);
  return webhookRequest({
    headers: {
      [header]: `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    },
    rawBody,
  });
}

const JIRA_HOOK_BODY = { issue: JIRA_ISSUE };

test("jira webhook verifies the signature on either header spelling", async () => {
  const { ctx, getHandler, getPath } = fakeTriggerCtx({
    jira: { ...JIRA_CFG, webhook: true, webhookSecret: "s3cret" },
  });
  const emitted: JiraIssueEvent[] = [];
  await jira.issueTransitioned({ to: "In Progress" }).start(ctx, (e) => void emitted.push(e));
  const handler = getHandler()!;
  assert.equal(getPath(), "/webhooks/jira");

  assert.equal((await handler(jiraSigned("wrong", JIRA_HOOK_BODY))).status, 401);
  assert.equal(emitted.length, 0);

  assert.equal((await handler(jiraSigned("s3cret", JIRA_HOOK_BODY))).status, 200);
  assert.equal(emitted.length, 1);

  // Atlassian sends x-hub-signature-256 on some products; both are accepted.
  assert.equal(
    (await handler(jiraSigned("s3cret", JIRA_HOOK_BODY, "x-hub-signature-256"))).status,
    200,
  );
  assert.equal(emitted.length, 2);
  assert.equal(emitted[0]!.ticket.identifier, "PROJ-7");
});

test("jira webhook accepts a bare hex signature without the sha256= prefix", async () => {
  const { ctx, getHandler } = fakeTriggerCtx({
    jira: { ...JIRA_CFG, webhook: true, webhookSecret: "s" },
  });
  await jira.issueTransitioned({ to: "In Progress" }).start(ctx, () => {});
  const rawBody = JSON.stringify(JIRA_HOOK_BODY);
  const res = await getHandler()!(
    webhookRequest({
      headers: {
        "x-hub-signature": createHmac("sha256", "s").update(rawBody).digest("hex"),
      },
      rawBody,
    }),
  );
  assert.equal(res.status, 200);
});

test("jira webhook fails closed without a webhookSecret", async () => {
  const { ctx, getHandler } = fakeTriggerCtx({
    jira: { ...JIRA_CFG, webhook: true },
  });
  const emitted: JiraIssueEvent[] = [];
  await jira.issueTransitioned({ to: "In Progress" }).start(ctx, (e) => void emitted.push(e));
  assert.equal((await getHandler()!(jiraSigned("any", JIRA_HOOK_BODY))).status, 401);
  assert.equal(emitted.length, 0);
});

test("jira webhook ignores a transition into a different status", async () => {
  const { ctx, getHandler } = fakeTriggerCtx({
    jira: { ...JIRA_CFG, webhook: true, webhookSecret: "s" },
  });
  const emitted: JiraIssueEvent[] = [];
  await jira.issueTransitioned({ to: "Done" }).start(ctx, (e) => void emitted.push(e));
  assert.equal((await getHandler()!(jiraSigned("s", JIRA_HOOK_BODY))).status, 200);
  assert.equal(emitted.length, 0);
  // A payload with no issue at all is accepted and ignored, not a 500.
  assert.equal((await getHandler()!(jiraSigned("s", { timestamp: 1 }))).status, 200);
  assert.equal(emitted.length, 0);
});

test("jira.comment posts ADF to the issue's comment endpoint and raises failures", async () => {
  await withFetch(
    (url) => (url.includes("PROJ-7") ? jsonResponse({ id: "1" }, 201) : jsonResponse({}, 404)),
    async (calls) => {
      await jira.comment(JIRA_CFG, "PROJ-7", "on it");
      assert.equal(calls[0]!.init!.method, "POST");
      assert.match(calls[0]!.url, /\/rest\/api\/3\/issue\/PROJ-7\/comment$/);
      const body = JSON.parse(calls[0]!.init!.body as string) as {
        body: {
          type: string;
          content: Array<{ content: Array<{ text: string }> }>;
        };
      };
      assert.equal(body.body.type, "doc");
      assert.equal(body.body.content[0]!.content[0]!.text, "on it");
    },
  );

  await withFetch(
    () => new Response("no such issue", { status: 404 }),
    async () => {
      await assert.rejects(jira.comment(JIRA_CFG, "PROJ-9", "hi"), /Jira comment 404/);
    },
  );

  await assert.rejects(jira.comment({}, "PROJ-7", "hi"), /missing host/);
});
