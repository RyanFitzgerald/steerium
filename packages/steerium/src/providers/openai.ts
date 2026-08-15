/**
 * OpenAI HTTP provider. Official `openai` SDK, Responses API as the
 * text path. Reads OPENAI_API_KEY (or provider config apiKey). Metered,
 * stateless — the server / company path.
 *
 * The SDK is imported lazily so steerium installs and runs (with mock) even
 * when `openai` is not present.
 */
import { defineProvider } from "../define.js";
import { resolveSecretOrEnv } from "../secrets.js";
import type { AgentResult, ProviderContext } from "../types.js";
import { openaiUsage } from "./usage.js";

async function loadSdk(): Promise<typeof import("openai")> {
  try {
    return await import("openai");
  } catch {
    throw new Error(
      'The "openai" package is not installed. Run `npm install openai` to use the openai provider.',
    );
  }
}

function apiKey(ctx: ProviderContext): string {
  const key = resolveSecretOrEnv(ctx.config.apiKey, "OPENAI_API_KEY");
  if (!key) {
    throw new Error("openai provider: no API key. Set OPENAI_API_KEY or providers.openai.apiKey.");
  }
  return key;
}

export const openaiProvider = defineProvider({
  name: "openai",
  supportsStructuredOutput: true,
  async run(opts, ctx): Promise<AgentResult> {
    const { default: OpenAI } = await loadSdk();
    const client = new OpenAI({ apiKey: apiKey(ctx) });
    const model = opts.model ?? (ctx.config.model as string | undefined) ?? "gpt-4o";

    const res = await client.responses.create(
      {
        model,
        instructions: opts.system,
        input: opts.prompt,
        ...(opts.maxTokens ? { max_output_tokens: opts.maxTokens } : {}),
        ...(opts.outputSchema
          ? {
              text: {
                format: {
                  type: "json_schema" as const,
                  name: "output",
                  schema: opts.outputSchema as Record<string, unknown>,
                },
              },
            }
          : {}),
      },
      { signal: ctx.signal },
    );

    return { text: res.output_text ?? "", usage: openaiUsage(res), raw: res };
  },
  health(ctx) {
    const key = resolveSecretOrEnv(ctx.config.apiKey, "OPENAI_API_KEY");
    return key
      ? { ok: true, auth: "api-key", detail: "OPENAI_API_KEY resolved" }
      : { ok: false, auth: "missing", detail: "set OPENAI_API_KEY" };
  },
});
