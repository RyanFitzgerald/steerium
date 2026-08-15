/**
 * Token-accounting formatters for CLI output.
 *
 * The rule these encode: a null token column means the provider did not report
 * that number, which is "unknown" and never 0. A run whose providers all stayed
 * quiet must render as "unknown", not as a confident "0 tok".
 */
import type { AgentCallRecord } from "../types.js";
import { bold, dim } from "./style.js";

/** 1234 -> "1.2k", 905_400 -> "905k", 12_345_678 -> "12.3M". */
export function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Calls whose provider reported usage / calls where it's unknown. */
  known: number;
  unknown: number;
}

export function sumAgentCalls(calls: AgentCallRecord[]): UsageTotals {
  const t: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreation: 0,
    known: 0,
    unknown: 0,
  };
  for (const c of calls) {
    const reported =
      c.input_tokens !== null ||
      c.output_tokens !== null ||
      c.cache_read_tokens !== null ||
      c.cache_creation_tokens !== null;
    if (!reported) {
      t.unknown++;
      continue;
    }
    t.known++;
    t.input += c.input_tokens ?? 0;
    t.output += c.output_tokens ?? 0;
    t.cacheRead += c.cache_read_tokens ?? 0;
    t.cacheCreation += c.cache_creation_tokens ?? 0;
  }
  return t;
}

/** Grand total = sum of all four fields (ccusage / OpenAI total_tokens convention). */
export function grandTotal(t: UsageTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheCreation;
}

/** Inline annotation for one step's agent calls, "" when the step is deterministic. */
export function fmtStepCalls(calls: AgentCallRecord[]): string {
  if (!calls.length) return "";
  const providers = [...new Set(calls.map((c) => c.provider))].join(",");
  const t = sumAgentCalls(calls);
  const label = `agent: ${providers}${calls.length > 1 ? ` ×${calls.length}` : ""}`;
  if (t.known === 0) return `  ${dim(`${label} · usage unknown`)}`;
  const suffix = t.unknown > 0 ? ` (+${t.unknown} unknown)` : "";
  return `  ${dim(`${label} · ${fmtTok(grandTotal(t))} tok${suffix}`)}`;
}

export function fmtBreakdown(t: UsageTotals): string {
  return `${fmtTok(t.input)} in / ${fmtTok(t.output)} out / ${fmtTok(t.cacheRead)} cache-read / ${fmtTok(t.cacheCreation)} cache-write`;
}

/** The run-level agent summary lines, or [] when the run made no agent calls. */
export function fmtRunUsage(calls: AgentCallRecord[], stepCount: number): string[] {
  if (!calls.length) return [];
  const t = sumAgentCalls(calls);
  const agentSteps = new Set(calls.filter((c) => c.step_id).map((c) => c.step_id)).size;
  const byProvider = new Map<string, number>();
  for (const c of calls) byProvider.set(c.provider, (byProvider.get(c.provider) ?? 0) + 1);
  const providers = [...byProvider.entries()]
    .map(([p, n]) => (n > 1 ? `${p} ×${n}` : p))
    .join(", ");

  const lines = [
    `  agent: ${calls.length} call${calls.length === 1 ? "" : "s"} (${providers}) · ${
      stepCount - agentSteps
    } of ${stepCount} steps deterministic`,
  ];
  if (t.known > 0) {
    const unknownNote =
      t.unknown > 0 ? ` · ${t.unknown} call${t.unknown === 1 ? "" : "s"} usage unknown` : "";
    lines.push(`  tokens: ${bold(fmtTok(grandTotal(t)))} total — ${fmtBreakdown(t)}${unknownNote}`);
  } else {
    lines.push(`  tokens: ${dim("unknown (provider did not report usage)")}`);
  }
  return lines;
}
