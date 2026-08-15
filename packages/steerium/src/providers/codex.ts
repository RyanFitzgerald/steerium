/**
 * Codex agent provider. Prefers `@openai/codex-sdk` (which itself spawns
 * the `codex` CLI and exchanges JSONL over stdio); falls back to raw `codex exec`
 * only when the SDK is unavailable. Runs in opts.cwd / scope.cwd, so it can
 * actually edit the project repo. Local-subscription auth by default.
 */
import { defineProvider } from "../define.js";
import { atomicWriteFile } from "../atomic-write.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./subprocess.js";
import type { AgentResult, AgentRunOptions, ProviderContext } from "../types.js";
import { codexUsage } from "./usage.js";

// The SDK is an optional, lazily-loaded dependency. Use a non-literal specifier
// so the type checker does not require the package to be installed.
const CODEX_SDK = "@openai/codex-sdk";

async function tryLoadSdk(): Promise<Record<string, unknown> | null> {
  try {
    return (await import(CODEX_SDK)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Map the cross-provider permissionMode onto Codex's sandbox levels. */
function sandboxFor(opts: AgentRunOptions, ctx: ProviderContext): string | undefined {
  const mode = opts.permissionMode ?? ctx.config.permissionMode;
  if (mode === "bypassPermissions") return "danger-full-access";
  if (mode === "acceptEdits") return "workspace-write";
  return mode === "default" ? "read-only" : undefined;
}

async function viaSdk(
  sdk: Record<string, unknown>,
  opts: AgentRunOptions,
  ctx: ProviderContext,
): Promise<AgentResult> {
  // The SDK surface: new Codex() -> startThread({...}) -> run(prompt).
  const Codex = (sdk as { Codex: new (cfg?: unknown) => unknown }).Codex;
  const codex = new Codex({ apiKey: ctx.config.apiKey }) as {
    startThread(o: Record<string, unknown>): {
      run(prompt: string, o?: Record<string, unknown>): Promise<{ finalResponse?: string; items?: unknown[] }>;
    };
  };
  const cwd = opts.cwd ?? ctx.scope.cwd;
  const sandbox = sandboxFor(opts, ctx);
  // Forward the options the SDK understands; unknown keys are ignored by it.
  const thread = codex.startThread({
    workingDirectory: cwd,
    ...(opts.model ? { model: opts.model } : {}),
    ...(sandbox ? { sandboxMode: sandbox } : {}),
    ...(opts.allowedTools ? { allowedTools: opts.allowedTools } : {}),
  });
  const fullPrompt = opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt;
  const result = await thread.run(fullPrompt, {
    signal: ctx.signal,
    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
  });
  return { text: result.finalResponse ?? "", usage: codexUsage(result), raw: result };
}

async function viaCli(opts: AgentRunOptions, ctx: ProviderContext): Promise<AgentResult> {
  ctx.logger.warn("codex: @openai/codex-sdk not installed; using degraded `codex exec` fallback");
  const cwd = opts.cwd ?? ctx.scope.cwd;
  const fullPrompt = opts.system ? `${opts.system}\n\n${opts.prompt}` : opts.prompt;
  const args = ["exec"];
  if (opts.model) args.push("--model", opts.model);
  const sandbox = sandboxFor(opts, ctx);
  if (sandbox) args.push("--sandbox", sandbox);
  if (opts.allowedTools?.length) {
    ctx.logger.warn("codex CLI fallback ignores allowedTools (no equivalent flag)");
  }
  let schemaDir: string | undefined;
  try {
    if (opts.outputSchema) {
      schemaDir = await mkdtemp(join(tmpdir(), "steerium-codex-schema-"));
      const schemaFile = join(schemaDir, "output-schema.json");
      await atomicWriteFile(schemaFile, JSON.stringify(opts.outputSchema));
      args.push("--output-schema", schemaFile);
    }
    args.push("-");
    const { stdout } = await runCli("codex", args, { cwd, input: fullPrompt, signal: ctx.signal });
    return { text: stdout.trim(), raw: { fallback: "cli" } };
  } finally {
    if (schemaDir) await rm(schemaDir, { recursive: true, force: true });
  }
}

export const codexProvider = defineProvider({
  name: "codex",
  supportsStructuredOutput: true,
  async run(opts, ctx): Promise<AgentResult> {
    if (!opts.permissionMode && !ctx.config.permissionMode) {
      ctx.logger.warn(
        'codex: no permissionMode set, so Codex runs in its default read-only sandbox — set permissionMode: "acceptEdits" to let the agent edit files',
      );
    }
    const sdk = await tryLoadSdk();
    return sdk ? viaSdk(sdk, opts, ctx) : viaCli(opts, ctx);
  },
  async health() {
    const sdk = await tryLoadSdk();
    if (sdk) return { ok: true, auth: "subscription", detail: "@openai/codex-sdk present" };
    try {
      const { stdout } = await runCli("codex", ["--version"], {
        signal: AbortSignal.timeout(10_000),
      });
      return {
        ok: true,
        auth: "subscription",
        detail: `SDK absent; \`codex\` CLI on PATH (${stdout.trim()}) — will use degraded \`codex exec\` fallback`,
      };
    } catch {
      return {
        ok: false,
        auth: "missing",
        detail: "neither @openai/codex-sdk nor a `codex` CLI on PATH — install the Codex CLI (and log in) or `npm install @openai/codex-sdk`",
      };
    }
  },
});
