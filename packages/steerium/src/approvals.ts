/**
 * Approvals: human-in-the-loop gates built on shared kv state, not engine
 * durability. `approvals.request` posts a question and *returns* — the run
 * ends; the pending record lives in the store. A second workflow listens with
 * `approvals.responded()`, a poll trigger that emits one event per human
 * reply, so waiting survives restarts and holds no concurrency slot.
 *
 * Replies arrive two ways, and both work at once: the control API
 * (`POST /approvals/<id>/respond`, used by the UI/CLI) appends to the record,
 * and an optional transport (e.g. Slack) delivers the request externally and
 * polls its own reply channel. Resolution is explicit — the responding
 * workflow calls `resolve` or `reask`; the engine never interprets a reply.
 */
import { randomUUID } from "node:crypto";
import { pollTrigger, type PollItem } from "./triggers/poll.js";
import type { KeyValueState, Logger, Scope, Trigger } from "./types.js";

/** The shared kv namespace (`ctx.kv(...)`) approvals live in, per scope. */
export const APPROVALS_NAMESPACE = "approvals";

export interface ApprovalReply {
  /** Stable id — dedups delivery of the same reply across poll ticks. */
  id: string;
  text: string;
  user?: string;
  at: number;
  /** Where it came from: "api" (control API / UI) or a transport kind. */
  via: string;
  /** Request round this reply answered. */
  requestId: string;
}

export interface ApprovalOption {
  value: string;
  label?: string;
  description?: string;
}

export interface ApprovalDisplay {
  kind: "markdown" | "code" | "diff" | "link";
  content: string;
  title?: string;
  language?: string;
}

export interface ApprovalRecord<P = unknown> {
  id: string;
  /** Unique per request/reask round; prevents delayed replies answering a newer question. */
  requestId: string;
  status: "pending" | "resolved" | "expired";
  /** The latest request text (updated by `reask`). */
  text: string;
  options?: ApprovalOption[];
  display?: ApprovalDisplay;
  allowFreeform: boolean;
  payload: P;
  /** How many times the request has been (re)asked. */
  rounds: number;
  /** Transport that delivered the request, with its opaque state (e.g. a thread id). */
  transport?: { kind: string; state?: unknown };
  /** Replies recorded locally (control API / UI). Transport replies are fetched live. */
  replies: ApprovalReply[];
  resolution?: { decision: string; at: number };
  /** Pending lifetime; `reask` refreshes `expiresAt` from it. */
  ttlMs?: number;
  requestedAt: number;
  updatedAt: number;
  expiresAt?: number;
}

export interface ApprovalEvent<P = unknown> {
  source: "approvals";
  type: "responded" | "expired";
  dedupeKey: string;
  approval: ApprovalRecord<P>;
  /** Present on "responded" events. */
  reply?: ApprovalReply;
}

/** What a transport gets to work with — satisfied by both run and trigger contexts. */
export interface ApprovalTransportContext {
  scope: Scope;
  logger: Logger;
  connector<T = unknown>(name: string): T;
}

/**
 * Delivers requests to (and reads replies from) one external channel. A
 * transport is stateless; whatever `send` returns is persisted on the record
 * and handed back, so a reask lands in the same Slack thread.
 */
export interface ApprovalTransport {
  kind: string;
  /** Deliver the request (or a reask). The return value is persisted as transport state. */
  send(
    ctx: ApprovalTransportContext,
    req: {
      id: string;
      requestId: string;
      text: string;
      rounds: number;
      options?: ApprovalOption[];
      display?: ApprovalDisplay;
      allowFreeform: boolean;
      state?: unknown;
    },
  ): Promise<unknown | void>;
  /** Poll for replies to a pending approval. Reply ids must be stable. */
  fetchReplies?(ctx: ApprovalTransportContext, record: ApprovalRecord): Promise<ApprovalReply[]>;
}

/** The slice of WorkflowContext the approval actions need (kept narrow for tests). */
export interface ApprovalContext {
  scope: Scope;
  logger: Logger;
  kv(namespace: string): KeyValueState;
  connector<T = unknown>(name: string): T;
}

export interface ApprovalRequestOptions<P = unknown> {
  /** Idempotency key: a pending request with the same id is returned, not re-sent. */
  id: string;
  text: string;
  payload?: P;
  options?: ApprovalOption[];
  display?: ApprovalDisplay;
  /** Permit a reply outside options. Default true. */
  allowFreeform?: boolean;
  via?: ApprovalTransport;
  /** How long the request stays pending before an "expired" event fires. */
  ttlMs?: number;
}

export interface ApprovalRespondedOptions {
  /** Transport(s) to poll for external replies, matched to records by kind. */
  via?: ApprovalTransport | ApprovalTransport[];
  /** Poll interval. Default 10s. */
  intervalMs?: number;
}

function transportCtx(ctx: ApprovalContext): ApprovalTransportContext {
  return { scope: ctx.scope, logger: ctx.logger, connector: (name) => ctx.connector(name) };
}

/** Upgrade records written before request-scoped replies were introduced. */
export function normalizeApprovalRecord<P = unknown>(record: ApprovalRecord<P>): ApprovalRecord<P> {
  const requestId = record.requestId ?? `legacy:${record.id}:${record.rounds}`;
  return {
    ...record,
    requestId,
    allowFreeform: record.allowFreeform ?? true,
    replies: record.replies.map((reply) => ({ ...reply, requestId: reply.requestId ?? requestId })),
  };
}

export const approvals = {
  /**
   * Post a request for human input and return immediately. The record is
   * visible at GET /approvals; a `via` transport additionally delivers it
   * externally. Idempotent while pending, so a replayed or double-fired run
   * doesn't ask twice.
   */
  async request<P = unknown>(
    ctx: ApprovalContext,
    opts: ApprovalRequestOptions<P>,
  ): Promise<ApprovalRecord<P>> {
    const kv = ctx.kv(APPROVALS_NAMESPACE);
    const stored = await kv.get<ApprovalRecord<P>>(opts.id);
    const existing = stored ? normalizeApprovalRecord(stored) : undefined;
    if (existing?.status === "pending") {
      ctx.logger.info(`approval "${opts.id}" already pending; not re-sending`);
      return existing;
    }
    const now = Date.now();
    const record: ApprovalRecord<P> = {
      id: opts.id,
      requestId: randomUUID(),
      status: "pending",
      text: opts.text,
      options: opts.options,
      display: opts.display,
      allowFreeform: opts.allowFreeform ?? true,
      payload: opts.payload as P,
      rounds: 1,
      replies: [],
      ttlMs: opts.ttlMs,
      requestedAt: now,
      updatedAt: now,
      expiresAt: opts.ttlMs ? now + opts.ttlMs : undefined,
    };
    if (opts.via) {
      const state = await opts.via.send(transportCtx(ctx), {
        id: opts.id,
        requestId: record.requestId,
        text: opts.text,
        rounds: 1,
        options: record.options,
        display: record.display,
        allowFreeform: record.allowFreeform,
      });
      record.transport = { kind: opts.via.kind, state: state ?? undefined };
    }
    await kv.set(record.id, record);
    ctx.logger.info(`approval "${record.id}" requested`, { via: opts.via?.kind ?? "local" });
    return record;
  },

  /**
   * Ask again on an existing approval (e.g. after revising a draft). Keeps the
   * id and transport state — a Slack transport posts into the same thread —
   * bumps `rounds`, and refreshes the TTL. Pass `payload` to carry the revised
   * work forward, so the next round builds on it rather than the original.
   */
  async reask<P = unknown>(
    ctx: ApprovalContext,
    opts: {
      id: string;
      text: string;
      payload?: P;
      options?: ApprovalOption[];
      display?: ApprovalDisplay;
      allowFreeform?: boolean;
      via?: ApprovalTransport;
    },
  ): Promise<ApprovalRecord<P>> {
    const kv = ctx.kv(APPROVALS_NAMESPACE);
    const stored = await kv.get<ApprovalRecord<P>>(opts.id);
    if (!stored) throw new Error(`approvals.reask: unknown approval "${opts.id}"`);
    const record = normalizeApprovalRecord(stored);
    const now = Date.now();
    const next: ApprovalRecord<P> = {
      ...record,
      requestId: randomUUID(),
      status: "pending",
      text: opts.text,
      options: opts.options ?? record.options,
      display: opts.display ?? record.display,
      allowFreeform: opts.allowFreeform ?? record.allowFreeform,
      payload: opts.payload === undefined ? record.payload : opts.payload,
      rounds: record.rounds + 1,
      updatedAt: now,
      expiresAt: record.ttlMs ? now + record.ttlMs : undefined,
      resolution: undefined,
    };
    if (opts.via) {
      const state = await opts.via.send(transportCtx(ctx), {
        id: opts.id,
        requestId: next.requestId,
        text: opts.text,
        rounds: next.rounds,
        options: next.options,
        display: next.display,
        allowFreeform: next.allowFreeform,
        state: record.transport?.state,
      });
      next.transport = { kind: opts.via.kind, state: state ?? record.transport?.state };
    }
    await kv.set(next.id, next);
    ctx.logger.info(`approval "${next.id}" re-asked (round ${next.rounds})`);
    return next;
  },

  /** Close an approval. Further replies stop firing events. */
  async resolve(ctx: ApprovalContext, id: string, decision = "approved"): Promise<void> {
    const kv = ctx.kv(APPROVALS_NAMESPACE);
    const stored = await kv.get<ApprovalRecord>(id);
    if (!stored) throw new Error(`approvals.resolve: unknown approval "${id}"`);
    const record = normalizeApprovalRecord(stored);
    const now = Date.now();
    await kv.set(id, {
      ...record,
      status: "resolved",
      resolution: { decision, at: now },
      updatedAt: now,
    });
    ctx.logger.info(`approval "${id}" resolved: ${decision}`);
  },

  async get<P = unknown>(ctx: ApprovalContext, id: string): Promise<ApprovalRecord<P> | undefined> {
    const record = await ctx.kv(APPROVALS_NAMESPACE).get<ApprovalRecord<P>>(id);
    return record ? normalizeApprovalRecord(record) : undefined;
  },

  /**
   * Trigger: fires once per human reply to a pending approval in this scope
   * (and once when a TTL'd approval expires). Local replies (control API / UI)
   * always count; pass `via` to also poll transports for external replies.
   */
  responded<P = unknown>(opts: ApprovalRespondedOptions = {}): Trigger<ApprovalEvent<P>> {
    const transports = opts.via ? (Array.isArray(opts.via) ? opts.via : [opts.via]) : [];
    return pollTrigger<ApprovalEvent<P>>({
      kind: "approvals.responded",
      intervalMs: opts.intervalMs ?? 10_000,
      async fetch(ctx) {
        const kv = ctx.kv(APPROVALS_NAMESPACE);
        const now = Date.now();
        const items: PollItem<ApprovalEvent<P>>[] = [];
        for (const { value } of await kv.list<ApprovalRecord<P>>()) {
          const record = normalizeApprovalRecord(value);
          if (record.status !== "pending") continue;

          if (record.expiresAt && record.expiresAt <= now) {
            const expired: ApprovalRecord<P> = { ...record, status: "expired", updatedAt: now };
            await kv.set(record.id, expired);
            const dedupeKey = `approval:${record.id}:expired:${record.expiresAt}`;
            items.push({
              id: dedupeKey,
              event: { source: "approvals", type: "expired", dedupeKey, approval: expired },
            });
            continue;
          }

          const replies = [...record.replies];
          for (const transport of transports) {
            if (transport.kind !== record.transport?.kind || !transport.fetchReplies) continue;
            replies.push(...(await transport.fetchReplies(ctx, record as ApprovalRecord)));
          }
          for (const originalReply of replies) {
            if (!originalReply.requestId && record.rounds > 1) continue;
            const reply = originalReply.requestId
              ? originalReply
              : { ...originalReply, requestId: record.requestId };
            if (reply.requestId !== record.requestId) continue;
            const dedupeKey = `approval:${record.id}:${reply.id}`;
            items.push({
              id: dedupeKey,
              event: { source: "approvals", type: "responded", dedupeKey, approval: record, reply },
            });
          }
        }
        return items;
      },
    });
  },
};

/**
 * Dumb keyword convention for reading a reply as an approval: "approve",
 * "approved", "lgtm", "ship it", or a leading 👍. Anything else — including
 * anything longer that merely starts with those words plus a "but…" — is the
 * workflow's job to interpret (a cheap classify call works well).
 */
export function isApprove(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.startsWith("👍")) return true;
  return /^(approved?|lgtm|ship ?it)[\s.!]*$/.test(t);
}

/** Append a locally-delivered reply (control API / UI) to a pending record. */
export function appendReply(
  record: ApprovalRecord,
  text: string,
  user?: string,
  requestId = record.requestId,
): ApprovalRecord {
  const reply: ApprovalReply = {
    id: randomUUID(),
    requestId,
    text,
    user,
    at: Date.now(),
    via: "api",
  };
  return { ...record, replies: [...record.replies, reply], updatedAt: reply.at };
}
