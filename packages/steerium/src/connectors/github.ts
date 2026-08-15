/**
 * GitHub connector. Same shape as the Linear reference connector: poll
 * mode by default (laptop-friendly, no public URL), webhook mode when the
 * process has a public URL. Triggers for new issues and pull requests, plus a
 * comment action. A token is optional for public repos (rate-limited).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineConnector } from "../define.js";
import { pollTrigger } from "../triggers/poll.js";
import type { Trigger, TriggerContext, WebhookRequest } from "../types.js";

export interface GithubIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
  repo: string;
  author: string;
}

export interface GithubIssueEvent {
  source: "github";
  type: "issueOpened";
  issue: GithubIssue;
  dedupeKey: string;
  raw?: unknown;
}

export interface GithubPullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  repo: string;
  author: string;
  /** Head branch name. */
  branch: string;
  baseBranch: string;
}

export interface GithubPullRequestEvent {
  source: "github";
  type: "prOpened";
  pr: GithubPullRequest;
  dedupeKey: string;
  raw?: unknown;
}

interface GithubConfig {
  /** PAT or installation token. Optional for public repos. */
  token?: string;
  /** Set true to receive webhooks instead of polling. */
  webhook?: boolean;
  /** HMAC-SHA256 secret for webhook signature verification (required in webhook mode). */
  webhookSecret?: string;
  /** API base for GitHub Enterprise Server. Default https://api.github.com. */
  apiBase?: string;
}

function cfg(ctx: TriggerContext): GithubConfig {
  return ctx.connector<GithubConfig>("github") ?? {};
}

async function rest<T>(c: GithubConfig, path: string, init?: RequestInit): Promise<T> {
  const base = (c.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const res = await fetch(base + path, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "steerium",
      ...(c.token ? { authorization: `Bearer ${c.token}` } : {}),
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${path}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface RestIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  labels: Array<{ name: string } | string>;
  user: { login: string } | null;
  /** Present when the "issue" is actually a pull request. */
  pull_request?: unknown;
}

interface RestPull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string };
  base: { ref: string };
}

function labelNames(labels: RestIssue["labels"]): string[] {
  return labels.map((l) => (typeof l === "string" ? l : l.name));
}

function toIssueEvent(repo: string, i: RestIssue): GithubIssueEvent {
  return {
    source: "github",
    type: "issueOpened",
    issue: {
      id: i.id,
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      state: i.state,
      labels: labelNames(i.labels),
      url: i.html_url,
      repo,
      author: i.user?.login ?? "",
    },
    dedupeKey: `github:${repo}#${i.number}:issueOpened`,
    raw: i,
  };
}

function toPrEvent(repo: string, p: RestPull): GithubPullRequestEvent {
  return {
    source: "github",
    type: "prOpened",
    pr: {
      id: p.id,
      number: p.number,
      title: p.title,
      body: p.body ?? "",
      state: p.state,
      url: p.html_url,
      repo,
      author: p.user?.login ?? "",
      branch: p.head.ref,
      baseBranch: p.base.ref,
    },
    dedupeKey: `github:${repo}#${p.number}:prOpened`,
    raw: p,
  };
}

/** Verify the `x-hub-signature-256: sha256=<hex>` HMAC GitHub webhooks send. */
function verifySignature(secret: string, req: WebhookRequest): boolean {
  const header = req.headers["x-hub-signature-256"];
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(req.rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(header.slice("sha256=".length)), Buffer.from(expected));
  } catch {
    return false;
  }
}

export interface IssueOpenedOptions {
  /** "owner/name". */
  repo: string;
  /** Only fire for issues carrying at least one of these labels. */
  labels?: string[];
  intervalMs?: number;
}

export interface PrOpenedOptions {
  /** "owner/name". */
  repo: string;
  intervalMs?: number;
}

/**
 * Wrap a poll trigger so webhook mode short-circuits polling when configured
 * (same pattern as the Linear reference connector).
 */
function withWebhook<E>(
  poll: Trigger<E>,
  handle: (body: Record<string, unknown>, ghEvent: string, emit: (e: E) => Promise<void>) => Promise<void>,
): Trigger<E> {
  return {
    kind: poll.kind,
    async start(ctx, emit) {
      const c = cfg(ctx);
      if (!c.webhook) return poll.start(ctx, emit);

      ctx.logger.info(`${poll.kind}: webhook mode`);
      ctx.registerWebhook("/webhooks/github", async (req) => {
        if (!c.webhookSecret || !verifySignature(c.webhookSecret, req)) {
          return { status: 401, body: "invalid signature" };
        }
        const ghEvent = req.headers["x-github-event"] ?? "";
        const body = JSON.parse(req.rawBody) as Record<string, unknown>;
        await handle(body, ghEvent, async (e) => void (await emit(e)));
        return { status: 200, body: "ok" };
      });
      return { stop() {} };
    },
  };
}

export const github = defineConnector({
  /** Trigger: fires once per newly opened issue (optionally label-filtered). */
  issueOpened(opts: IssueOpenedOptions): Trigger<GithubIssueEvent> {
    const intervalMs = opts.intervalMs ?? 60_000;
    const labelsQuery = opts.labels?.length
      ? `&labels=${encodeURIComponent(opts.labels.join(","))}`
      : "";

    const poll = pollTrigger<GithubIssueEvent>({
      kind: "github.issueOpened",
      intervalMs,
      stateKey: `seen:${opts.repo}:${opts.labels?.join(",") ?? ""}`,
      async fetch(ctx) {
        const c = cfg(ctx);
        const issues = await rest<RestIssue[]>(
          c,
          `/repos/${opts.repo}/issues?state=open&sort=created&direction=desc&per_page=50${labelsQuery}`,
        );
        return issues
          .filter((i) => !i.pull_request) // the issues API also returns PRs
          .map((i) => ({ id: `${opts.repo}#${i.number}`, event: toIssueEvent(opts.repo, i) }));
      },
    });

    return withWebhook(poll, async (body, ghEvent, emit) => {
      if (ghEvent !== "issues") return;
      const action = body.action as string;
      const issue = body.issue as RestIssue | undefined;
      const repoName = (body.repository as { full_name?: string } | undefined)?.full_name;
      if (!issue || repoName !== opts.repo) return;

      const wanted = opts.labels;
      // No label filter: fire on open. With a filter: fire on open-with-label
      // or when a matching label is added later.
      const fire =
        (action === "opened" &&
          (!wanted?.length || labelNames(issue.labels).some((l) => wanted.includes(l)))) ||
        (action === "labeled" &&
          !!wanted?.length &&
          wanted.includes((body.label as { name?: string } | undefined)?.name ?? ""));
      if (fire) await emit(toIssueEvent(opts.repo, issue));
    });
  },

  /** Trigger: fires once per newly opened pull request. */
  prOpened(opts: PrOpenedOptions): Trigger<GithubPullRequestEvent> {
    const intervalMs = opts.intervalMs ?? 60_000;

    const poll = pollTrigger<GithubPullRequestEvent>({
      kind: "github.prOpened",
      intervalMs,
      stateKey: `seen:${opts.repo}`,
      async fetch(ctx) {
        const c = cfg(ctx);
        const pulls = await rest<RestPull[]>(
          c,
          `/repos/${opts.repo}/pulls?state=open&sort=created&direction=desc&per_page=50`,
        );
        return pulls.map((p) => ({ id: `${opts.repo}#${p.number}`, event: toPrEvent(opts.repo, p) }));
      },
    });

    return withWebhook(poll, async (body, ghEvent, emit) => {
      if (ghEvent !== "pull_request" || body.action !== "opened") return;
      const pr = body.pull_request as RestPull | undefined;
      const repoName = (body.repository as { full_name?: string } | undefined)?.full_name;
      if (!pr || repoName !== opts.repo) return;
      await emit(toPrEvent(opts.repo, pr));
    });
  },

  /** Action: comment on an issue or pull request. */
  async comment(token: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await rest({ token }, `/repos/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  },
});
