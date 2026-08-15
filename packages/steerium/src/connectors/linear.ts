/**
 * Linear connector. Reference connector: triggers + actions packaged on
 * the public API only. Poll mode by default (laptop-friendly, no public URL);
 * webhook mode when the process has a public URL.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineConnector } from "../define.js";
import { pollTrigger } from "../triggers/poll.js";
import type { Trigger, TriggerContext, WebhookRequest } from "../types.js";

const LINEAR_API = "https://api.linear.app/graphql";

export interface LinearTicket {
  id: string;
  identifier: string;
  title: string;
  description: string;
  status: string;
}

export interface LinearTicketEvent {
  source: "linear";
  type: "ticketMoved";
  ticket: LinearTicket;
  raw?: unknown;
}

interface LinearConfig {
  apiKey?: string;
  /** HMAC secret for webhook signature verification. */
  webhookSecret?: string;
  /** Set true to receive webhooks instead of polling. */
  webhook?: boolean;
}

function cfg(ctx: TriggerContext): LinearConfig {
  return ctx.connector<LinearConfig>("linear") ?? {};
}

async function graphql<T>(apiKey: string, query: string, variables?: unknown): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors) throw new Error(`Linear GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data as T;
}

interface IssuesResponse {
  issues: {
    nodes: Array<{
      id: string;
      identifier: string;
      title: string;
      description: string | null;
      updatedAt: string;
      state: { name: string };
    }>;
  };
}

const ISSUES_QUERY = `
  query IssuesInState($state: String!) {
    issues(filter: { state: { name: { eq: $state } } }, first: 50, orderBy: updatedAt) {
      nodes { id identifier title description updatedAt state { name } }
    }
  }
`;

function toEvent(node: IssuesResponse["issues"]["nodes"][number]): LinearTicketEvent {
  return {
    source: "linear",
    type: "ticketMoved",
    ticket: {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description ?? "",
      status: node.state.name,
    },
    raw: node,
  };
}

function verifySignature(secret: string, req: WebhookRequest): boolean {
  const sig = req.headers["linear-signature"];
  if (!sig) return false;
  const expected = createHmac("sha256", secret).update(req.rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

export interface TicketMovedOptions {
  to: string;
  intervalMs?: number;
}

export const linear = defineConnector({
  /** Trigger: fires when an issue is in (moved to) the configured state. */
  ticketMoved(opts: TicketMovedOptions): Trigger<LinearTicketEvent> {
    const intervalMs = opts.intervalMs ?? 60_000;

    const poll = pollTrigger<LinearTicketEvent>({
      kind: "linear.ticketMoved",
      intervalMs,
      stateKey: `seen:${opts.to}`,
      async fetch(ctx) {
        const c = cfg(ctx);
        if (!c.apiKey) throw new Error("linear: missing connectors.linear.apiKey");
        const data = await graphql<IssuesResponse>(c.apiKey, ISSUES_QUERY, { state: opts.to });
        // Dedup by issue id + state so a re-entry into the state re-fires.
        return data.issues.nodes.map((n) => ({ id: `${n.id}:${opts.to}`, event: toEvent(n) }));
      },
    });

    // Wrap so webhook mode short-circuits polling when configured.
    return {
      kind: poll.kind,
      async start(ctx, emit) {
        const c = cfg(ctx);
        if (!c.webhook) return poll.start(ctx, emit);

        ctx.logger.info("linear.ticketMoved: webhook mode");
        ctx.registerWebhook("/webhooks/linear", async (req) => {
          if (!c.webhookSecret || !verifySignature(c.webhookSecret, req)) {
            return { status: 401, body: "invalid signature" };
          }
          const body = JSON.parse(req.rawBody) as {
            action: string;
            type: string;
            data: { id: string; identifier: string; title: string; description?: string; state?: { name: string } };
          };
          const state = body.data.state?.name;
          if (body.type === "Issue" && state === opts.to) {
            await emit({
              source: "linear",
              type: "ticketMoved",
              ticket: {
                id: body.data.id,
                identifier: body.data.identifier,
                title: body.data.title,
                description: body.data.description ?? "",
                status: state,
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

  /** Action: post a comment back to an issue. */
  async comment(apiKey: string, ticketId: string, body: string): Promise<void> {
    const mutation = `
      mutation Comment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) { success }
      }
    `;
    await graphql(apiKey, mutation, { issueId: ticketId, body });
  },
});
