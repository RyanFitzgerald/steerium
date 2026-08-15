/**
 * Mock provider. Echoes a deterministic response so the whole system
 * runs with zero credentials. Default in `steerium init` and in tests.
 */
import { defineProvider } from "../define.js";
import type { AgentResult } from "../types.js";

export const mockProvider = defineProvider({
  name: "mock",
  async run(opts): Promise<AgentResult> {
    const head = opts.prompt.slice(0, 280);
    const text = `[mock:${opts.model ?? "default"}] ${head}`;
    return {
      text,
      // Deterministic fake usage (char counts as token counts) so the token
      // accounting pipeline is exercised and assertable in tests.
      usage: {
        inputTokens: opts.prompt.length,
        outputTokens: text.length,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        model: opts.model ?? "mock",
      },
      raw: {
        provider: "mock",
        promptChars: opts.prompt.length,
        system: opts.system ?? null,
        cwd: opts.cwd ?? null,
      },
    };
  },
  health() {
    return { ok: true, auth: "mock", detail: "always available, no credentials" };
  },
});
