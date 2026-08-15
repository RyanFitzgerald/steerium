/**
 * Claude agent provider. Prefers `@anthropic-ai/claude-agent-sdk` (which
 * spawns the Claude Code binary as a subprocess); falls back to raw `claude -p`
 * only when the SDK is unavailable. Surfaces the SDK's native permissionMode and
 * allowedTools — this is why steerium needs no policy engine of its own.
 *
 * The SDK is proprietary-licensed; this provider code is open, the dependency is
 * not, so it is imported lazily and never a hard requirement.
 */
import { defineProvider } from "../define.js";
import { runCli } from "./subprocess.js";
import type { AgentResult, AgentRunOptions, ProviderContext } from "../types.js";
import { AgentCallError, claudeJsonUsage, claudeResultError, claudeSdkUsage } from "./usage.js";

// Optional, proprietary-licensed dependency; lazily loaded via a non-literal
// specifier so the type checker does not require it to be installed.
const CLAUDE_SDK = "@anthropic-ai/claude-agent-sdk";

async function tryLoadSdk(): Promise<Record<string, unknown> | null> {
  try {
    return (await import(CLAUDE_SDK)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function viaSdk(
  sdk: Record<string, unknown>,
  opts: AgentRunOptions,
  ctx: ProviderContext,
): Promise<AgentResult> {
  const query = (sdk as { query: (a: unknown) => AsyncIterable<Record<string, unknown>> }).query;
  const cwd = opts.cwd ?? ctx.scope.cwd;
  const messages: Record<string, unknown>[] = [];
  let text = "";

  // The SDK takes its own AbortController; bridge the run's timeout signal to it.
  const abortController = new AbortController();
  if (ctx.signal) {
    if (ctx.signal.aborted) abortController.abort();
    else ctx.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const iterable = query({
    prompt: opts.prompt,
    options: {
      cwd,
      abortController,
      ...(opts.system ? { systemPrompt: opts.system } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      permissionMode: opts.permissionMode ?? ctx.config.permissionMode ?? "default",
      ...(opts.allowedTools ?? ctx.config.allowedTools
        ? { allowedTools: opts.allowedTools ?? ctx.config.allowedTools }
        : {}),
      ...(opts.outputSchema
        ? { outputFormat: { type: "json_schema", schema: opts.outputSchema } }
        : {}),
    },
  });

  try {
    for await (const message of iterable) {
      messages.push(message);
      if (message["type"] === "result" && typeof message["result"] === "string") {
        text = message["result"] as string;
      }
    }
  } catch (err) {
    // Abort/crash mid-run: the iterator rejects before a result message
    // arrives. The assistant messages consumed so far still carry usage —
    // surface it on the error so the tokens burned are not lost.
    const usage = claudeSdkUsage(messages);
    if (usage) {
      throw new AgentCallError(err instanceof Error ? err.message : String(err), {
        usage,
        cause: err,
      });
    }
    throw err;
  }

  const usage = claudeSdkUsage(messages);
  // Failures (error_during_execution, error_max_turns, ...) arrive as normal
  // result messages with is_error: true — the iterable resolves. Surface them
  // as failures instead of returning an empty "ok" result.
  const failure = claudeResultError(messages);
  if (failure) throw new AgentCallError(failure, { usage });

  const resultMessage = messages.findLast((message) => message["type"] === "result");
  const data = resultMessage?.["structured_output"];
  return { text: data === undefined ? text : JSON.stringify(data), data, usage, raw: messages };
}

async function viaCli(opts: AgentRunOptions, ctx: ProviderContext): Promise<AgentResult> {
  ctx.logger.warn(
    "claude: @anthropic-ai/claude-agent-sdk not installed; using degraded `claude -p` fallback",
  );
  const cwd = opts.cwd ?? ctx.scope.cwd;
  // JSON output carries usage + total_cost_usd alongside the result text.
  const args = ["-p", opts.prompt, "--output-format", "json"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  if (opts.outputSchema) args.push("--json-schema", JSON.stringify(opts.outputSchema));
  const { stdout } = await runCli("claude", args, { cwd, signal: ctx.signal });
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { text: stdout.trim(), raw: { fallback: "cli" } };
  }
  const usage = claudeJsonUsage(parsed);
  // Same error surface as the SDK path: a JSON result with is_error is a failure.
  const failure = claudeResultError([parsed]);
  if (failure) throw new AgentCallError(failure, usage ? { usage } : undefined);
  const data = parsed["structured_output"];
  const text = data === undefined
    ? typeof parsed["result"] === "string" ? parsed["result"] : stdout.trim()
    : JSON.stringify(data);
  return { text, data, usage, raw: { fallback: "cli", result: parsed } };
}

export const claudeProvider = defineProvider({
  name: "claude",
  supportsStructuredOutput: true,
  async run(opts, ctx): Promise<AgentResult> {
    if (!opts.permissionMode && !ctx.config.permissionMode) {
      ctx.logger.warn(
        'claude: no permissionMode set, and "default" cannot approve tool prompts in a headless run — set permissionMode: "acceptEdits" to let the agent edit files',
      );
    }
    const sdk = await tryLoadSdk();
    return sdk ? viaSdk(sdk, opts, ctx) : viaCli(opts, ctx);
  },
  async health() {
    const sdk = await tryLoadSdk();
    if (sdk) return { ok: true, auth: "subscription", detail: "@anthropic-ai/claude-agent-sdk present" };
    try {
      const { stdout } = await runCli("claude", ["--version"], {
        signal: AbortSignal.timeout(10_000),
      });
      return {
        ok: true,
        auth: "subscription",
        detail: `SDK absent; \`claude\` CLI on PATH (${stdout.trim()}) — will use degraded \`claude -p\` fallback`,
      };
    } catch {
      return {
        ok: false,
        auth: "missing",
        detail: "neither @anthropic-ai/claude-agent-sdk nor a `claude` CLI on PATH — install Claude Code (and log in) or `npm install @anthropic-ai/claude-agent-sdk`",
      };
    }
  },
});
