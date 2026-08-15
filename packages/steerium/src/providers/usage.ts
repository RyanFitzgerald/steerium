/**
 * Pure usage-extraction helpers, one per provider response shape. Kept free of
 * SDK imports so they can be unit-tested without the optional dependencies
 * installed.
 *
 * Normalization contract (see AgentUsage in types.ts): the four token fields
 * are DISJOINT — `inputTokens` excludes cache reads/writes — so the grand
 * total is the sum of all four. Anthropic already reports this shape; OpenAI
 * and Codex report cached tokens as a *subset* of input, so those mappings
 * subtract. Return undefined (not zeros) when the provider reported nothing:
 * "unknown" and "zero" are different facts.
 */
import type { AgentUsage } from "../types.js";

/**
 * An agent-call failure that still burned tokens. Providers throw this (rather
 * than a bare Error) when they know the usage at failure time — the registry
 * facade reads `usage` off it so the error row in agent_calls is not recorded
 * as "usage unknown".
 */
export class AgentCallError extends Error {
  readonly usage?: AgentUsage;

  constructor(message: string, opts?: { usage?: AgentUsage; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "AgentCallError";
    this.usage = opts?.usage;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** Anthropic Messages API response: usage fields are already disjoint. */
export function anthropicUsage(res: unknown): AgentUsage | undefined {
  const r = obj(res);
  const u = obj(r?.usage);
  if (!u) return undefined;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    ...(typeof r?.model === "string" ? { model: r.model } : {}),
  };
}

/**
 * OpenAI Responses API: `input_tokens` INCLUDES `input_tokens_details.cached_tokens`.
 * Subtract so the fields stay disjoint; sum-of-fields then equals OpenAI's own
 * total_tokens.
 */
export function openaiUsage(res: unknown): AgentUsage | undefined {
  const r = obj(res);
  const u = obj(r?.usage);
  if (!u) return undefined;
  const input = num(u.input_tokens);
  const cached = num(obj(u.input_tokens_details)?.cached_tokens) ?? 0;
  return {
    inputTokens: input === undefined ? undefined : Math.max(0, input - cached),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: cached,
    ...(typeof r?.model === "string" ? { model: r.model } : {}),
  };
}

/**
 * Claude Agent SDK message stream. The final `result` message carries the
 * turn's cumulative usage plus provider-reported `total_cost_usd` — use ONLY
 * that (summing per-message usage as well would double count). When the run
 * aborted before a result message, fall back to summing the per-assistant-
 * message usage that did arrive.
 */
export function claudeSdkUsage(messages: unknown[]): AgentUsage | undefined {
  let model: string | undefined;
  for (const m of messages) {
    const msg = obj(obj(m)?.message);
    if (obj(m)?.type === "assistant" && typeof msg?.model === "string") model = msg.model;
  }

  const result = messages.map(obj).find((m) => m?.type === "result");
  if (result) {
    const u = obj(result.usage);
    if (u) {
      return {
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheCreationTokens: num(u.cache_creation_input_tokens),
        costUsd: num(result.total_cost_usd),
        ...(model ? { model } : {}),
      };
    }
  }

  // Aborted before a result message: sum what the assistant messages reported.
  let found = false;
  const total = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const m of messages) {
    const wrapper = obj(m);
    if (wrapper?.type !== "assistant") continue;
    const u = obj(obj(wrapper.message)?.usage);
    if (!u) continue;
    found = true;
    total.input += num(u.input_tokens) ?? 0;
    total.output += num(u.output_tokens) ?? 0;
    total.cacheRead += num(u.cache_read_input_tokens) ?? 0;
    total.cacheCreation += num(u.cache_creation_input_tokens) ?? 0;
  }
  if (!found) return undefined;
  return {
    inputTokens: total.input,
    outputTokens: total.output,
    cacheReadTokens: total.cacheRead,
    cacheCreationTokens: total.cacheCreation,
    ...(model ? { model } : {}),
  };
}

/**
 * The Claude Agent SDK reports failures (error_during_execution,
 * error_max_turns, ...) as normal `result` messages with `is_error: true` —
 * the iterator does not necessarily reject. Returns a description when the
 * run's result is an error, else null.
 */
export function claudeResultError(messages: unknown[]): string | null {
  const result = messages.map(obj).find((m) => m?.type === "result");
  if (!result) return null;
  const subtype = typeof result.subtype === "string" ? result.subtype : "";
  if (result.is_error !== true && !subtype.startsWith("error")) return null;
  const detail = typeof result.result === "string" && result.result ? `: ${result.result}` : "";
  return `claude: ${subtype || "error"}${detail}`;
}

/** `claude -p --output-format json` output: same usage shape as the SDK result message. */
export function claudeJsonUsage(parsed: unknown): AgentUsage | undefined {
  const r = obj(parsed);
  const u = obj(r?.usage);
  if (!u) return undefined;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
    costUsd: num(r?.total_cost_usd),
  };
}

/**
 * Codex SDK thread-run result: OpenAI semantics, `cached_input_tokens` is a
 * subset of `input_tokens` — subtract to keep fields disjoint.
 */
export function codexUsage(result: unknown): AgentUsage | undefined {
  const u = obj(obj(result)?.usage);
  if (!u) return undefined;
  const input = num(u.input_tokens);
  const cached = num(u.cached_input_tokens) ?? 0;
  return {
    inputTokens: input === undefined ? undefined : Math.max(0, input - cached),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: cached,
  };
}
