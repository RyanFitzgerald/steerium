/**
 * Anthropic HTTP provider. `@anthropic-ai/sdk`, Messages API. Reads
 * ANTHROPIC_API_KEY (or provider config apiKey). The server / company path.
 *
 * SDK imported lazily so the core installs without it.
 */
import { defineProvider } from "../define.js";
import { resolveSecretOrEnv } from "../secrets.js";
import type { AgentResult, ProviderContext } from "../types.js";
import { anthropicUsage } from "./usage.js";

async function loadSdk(): Promise<typeof import("@anthropic-ai/sdk")> {
  try {
    return await import("@anthropic-ai/sdk");
  } catch {
    throw new Error(
      'The "@anthropic-ai/sdk" package is not installed. Run `npm install @anthropic-ai/sdk` to use the anthropic provider.',
    );
  }
}

function apiKey(ctx: ProviderContext): string {
  const key = resolveSecretOrEnv(ctx.config.apiKey, "ANTHROPIC_API_KEY");
  if (!key) {
    throw new Error(
      "anthropic provider: no API key. Set ANTHROPIC_API_KEY or providers.anthropic.apiKey.",
    );
  }
  return key;
}

export const anthropicProvider = defineProvider({
  name: "anthropic",
  supportsStructuredOutput: true,
  async run(opts, ctx): Promise<AgentResult> {
    const { default: Anthropic } = await loadSdk();
    const client = new Anthropic({ apiKey: apiKey(ctx) });
    const model = opts.model ?? (ctx.config.model as string | undefined) ?? "claude-opus-4-8";

    const schema = opts.outputSchema as Record<string, unknown> | undefined;
    if (schema?.type !== undefined && schema.type !== "object") {
      throw new Error("anthropic structured output schema must have type: object");
    }
    const structuredTool = schema
      ? {
          name: "structured_output",
          description: "Return the requested structured output.",
          input_schema: { ...schema, type: "object" as const },
        }
      : undefined;
    const res = await client.messages.create(
      {
        model,
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.system ? { system: opts.system } : {}),
        messages: [{ role: "user", content: opts.prompt }],
        ...(structuredTool
          ? {
              tools: [structuredTool],
              tool_choice: { type: "tool" as const, name: structuredTool.name },
            }
          : {}),
      },
      { signal: ctx.signal },
    );

    const structured = res.content.find(
      (block) => block.type === "tool_use" && block.name === "structured_output",
    );
    const data = structured?.type === "tool_use" ? structured.input : undefined;
    const text = data === undefined
      ? res.content.map((block) => (block.type === "text" ? block.text : "")).join("")
      : JSON.stringify(data);

    return { text, data, usage: anthropicUsage(res), raw: res };
  },
  health(ctx) {
    const key = resolveSecretOrEnv(ctx.config.apiKey, "ANTHROPIC_API_KEY");
    return key
      ? { ok: true, auth: "api-key", detail: "ANTHROPIC_API_KEY resolved" }
      : { ok: false, auth: "missing", detail: "set ANTHROPIC_API_KEY" };
  },
});
