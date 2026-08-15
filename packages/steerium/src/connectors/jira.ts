/**
 * Jira connector. Identical shape to Linear, different backend: poll the
 * Jira REST API with a JQL filter, or receive Jira webhooks. Proves the
 * connector pattern generalizes beyond one vendor.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineConnector } from "../define.js";
import { pollTrigger } from "../triggers/poll.js";
import type { Trigger, TriggerContext, WebhookRequest } from "../types.js";

export interface JiraIssue {
  id: string;
  identifier: string; // issue key, e.g. PROJ-123
  title: string;
  description: string;
  status: string;
}

export interface JiraIssueEvent {
  source: "jira";
  type: "issueTransitioned";
  ticket: JiraIssue;
  raw?: unknown;
}

interface JiraConfig {
  /** e.g. https://your-org.atlassian.net */
  host?: string;
  email?: string;
  apiToken?: string;
  webhook?: boolean;
  /** HMAC-SHA256 secret for webhook signature verification (required in webhook mode). */
  webhookSecret?: string;
}

function cfg(ctx: TriggerContext): JiraConfig {
  return ctx.connector<JiraConfig>("jira") ?? {};
}

/** Verify the `x-hub-signature: sha256=<hex>` HMAC Jira/Atlassian webhooks send. */
function verifySignature(secret: string, req: WebhookRequest): boolean {
  const header = req.headers["x-hub-signature"] ?? req.headers["x-hub-signature-256"];
  if (!header) return false;
  const provided = header.includes("=") ? header.split("=")[1]! : header;
  const expected = createHmac("sha256", secret).update(req.rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

function authHeader(c: JiraConfig): string {
  const token = Buffer.from(`${c.email}:${c.apiToken}`).toString("base64");
  return `Basic ${token}`;
}

interface JiraSearchResponse {
  issues: Array<{
    id: string;
    key: string;
    fields: {
      summary: string;
      description?: string | null;
      status: { name: string };
      updated: string;
    };
  }>;
}

async function search(c: JiraConfig, jql: string): Promise<JiraSearchResponse> {
  if (!c.host || !c.email || !c.apiToken) {
    throw new Error("jira: missing connectors.jira.{host,email,apiToken}");
  }
  const url = new URL("/rest/api/3/search", c.host);
  url.searchParams.set("jql", jql);
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("fields", "summary,description,status,updated");
  const res = await fetch(url, {
    headers: { authorization: authHeader(c), accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Jira API ${res.status}: ${await res.text()}`);
  return (await res.json()) as JiraSearchResponse;
}

function toEvent(issue: JiraSearchResponse["issues"][number]): JiraIssueEvent {
  return {
    source: "jira",
    type: "issueTransitioned",
    ticket: {
      id: issue.id,
      identifier: issue.key,
      title: issue.fields.summary,
      description:
        typeof issue.fields.description === "string" ? issue.fields.description : "",
      status: issue.fields.status.name,
    },
    raw: issue,
  };
}

export interface IssueTransitionedOptions {
  to: string;
  /** Optional extra JQL to AND with the status filter. */
  jql?: string;
  intervalMs?: number;
}

export const jira = defineConnector({
  /** Trigger: fires when an issue transitions into the configured status. */
  issueTransitioned(opts: IssueTransitionedOptions): Trigger<JiraIssueEvent> {
    const intervalMs = opts.intervalMs ?? 60_000;
    const jql = [`status = "${opts.to}"`, opts.jql].filter(Boolean).join(" AND ");

    const poll = pollTrigger<JiraIssueEvent>({
      kind: "jira.issueTransitioned",
      intervalMs,
      stateKey: `seen:${opts.to}`,
      async fetch(ctx) {
        const data = await search(cfg(ctx), jql);
        return data.issues.map((i) => ({ id: `${i.id}:${opts.to}`, event: toEvent(i) }));
      },
    });

    return {
      kind: poll.kind,
      async start(ctx, emit) {
        const c = cfg(ctx);
        if (!c.webhook) return poll.start(ctx, emit);

        ctx.logger.info("jira.issueTransitioned: webhook mode");
        ctx.registerWebhook("/webhooks/jira", async (req: WebhookRequest) => {
          // Fail closed: no secret configured means we cannot trust the payload.
          if (!c.webhookSecret || !verifySignature(c.webhookSecret, req)) {
            return { status: 401, body: "invalid signature" };
          }
          const body = JSON.parse(req.rawBody) as {
            issue?: {
              id: string;
              key: string;
              fields: { summary: string; description?: string; status: { name: string } };
            };
          };
          const issue = body.issue;
          if (issue && issue.fields.status.name === opts.to) {
            await emit({
              source: "jira",
              type: "issueTransitioned",
              ticket: {
                id: issue.id,
                identifier: issue.key,
                title: issue.fields.summary,
                description: issue.fields.description ?? "",
                status: issue.fields.status.name,
              },
              raw: body,
            });
          }
          return { status: 200, body: "ok" };
        });
        return { stop() {} };
      },
    };
  },

  /** Action: add a comment to an issue. */
  async comment(c: JiraConfig, issueKey: string, body: string): Promise<void> {
    if (!c.host) throw new Error("jira: missing host");
    const url = new URL(`/rest/api/3/issue/${issueKey}/comment`, c.host);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: authHeader(c),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
        },
      }),
    });
    if (!res.ok) throw new Error(`Jira comment ${res.status}: ${await res.text()}`);
  },
});
