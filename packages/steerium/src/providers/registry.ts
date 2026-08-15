/**
 * Provider registry + the Agent facade. Built-ins are registered
 * exactly the same way a third-party `provider-foo` package would be, so they
 * hold no privileged access.
 */
import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentResult,
  AgentRunOptions,
  AgentUsage,
  Logger,
  Provider,
  ProviderConfig,
  Scope,
  SteeriumConfig,
} from "../types.js";
import { anthropicProvider } from "./anthropic.js";
import { claudeProvider } from "./claude.js";
import { codexProvider } from "./codex.js";
import { mockProvider } from "./mock.js";
import { openaiProvider } from "./openai.js";
import type { AgentCallError } from "./usage.js";
import { normalizeStructuredResult, outputJsonSchema } from "./structured-output.js";

/**
 * One settled `agent.run` call, as seen by the facade. The observer (the
 * runner) adds run/step attribution and persists it. Reported for failed and
 * aborted calls too — those burned tokens as well, even when the usage is
 * unknowable after the fact.
 */
export interface SettledAgentCall {
  id: string;
  provider: string;
  /** Provider-reported model when available, else the requested one. */
  model: string | null;
  status: "ok" | "failed" | "cancelled" | "timed_out";
  usage?: AgentUsage;
  startedAt: number;
  finishedAt: number;
  error: string | null;
}

export interface StartedAgentCall {
  id: string;
  provider: string;
  model: string | null;
  startedAt: number;
}

export interface AgentCallObserverCallbacks {
  started(call: StartedAgentCall): void;
  settled(call: SettledAgentCall): void;
}

export type AgentCallObserver = AgentCallObserverCallbacks | ((call: SettledAgentCall) => void);

function isProvider(v: ProviderConfig | Provider): v is Provider {
  return typeof (v as Provider).run === "function" && typeof (v as Provider).name === "string";
}

export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  private configs = new Map<string, ProviderConfig>();
  readonly defaultProvider: string;

  constructor(config: SteeriumConfig) {
    // Built-ins first.
    for (const p of [mockProvider, openaiProvider, anthropicProvider, codexProvider, claudeProvider]) {
      this.providers.set(p.name, p);
    }
    // Config entries either override settings for a built-in or register a new provider.
    for (const [name, entry] of Object.entries(config.providers ?? {})) {
      if (isProvider(entry)) {
        this.providers.set(name, entry);
      } else {
        this.configs.set(name, entry);
      }
    }
    this.defaultProvider = config.defaults?.provider ?? "mock";
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  list(): string[] {
    return [...this.providers.keys()];
  }

  get(name: string): Provider {
    const p = this.providers.get(name);
    if (!p) {
      throw new Error(
        `Unknown provider "${name}". Registered: ${this.list().join(", ")}.`,
      );
    }
    return p;
  }

  configFor(name: string): ProviderConfig {
    return this.configs.get(name) ?? {};
  }

  /**
   * Build a scoped Agent facade for one run. The signal aborts in-flight
   * calls. Every call — success, failure, or abort — is reported to `observe`
   * when given; this is the single choke point token accounting hangs off.
   */
  agentFor(scope: Scope, logger: Logger, signal?: AbortSignal, observe?: AgentCallObserver): Agent {
    return {
      run: async <T = unknown>(opts: AgentRunOptions<T>): Promise<AgentResult<T>> => {
        const name = opts.provider ?? this.defaultProvider;
        const provider = this.get(name);
        if (opts.outputSchema && provider.supportsStructuredOutput !== true) {
          throw new Error(
            `provider "${name}" does not declare supportsStructuredOutput: true`,
          );
        }
        const ctx = {
          scope,
          logger: logger.child({ provider: name }),
          config: this.configFor(name),
          signal,
        };
        const callId = randomUUID();
        const startedAt = Date.now();
        const providerOpts = opts.outputSchema
          ? { ...opts, outputSchema: outputJsonSchema(opts.outputSchema) }
          : opts;
        try {
          if (observe && typeof observe !== "function") {
            observe.started({
              id: callId,
              provider: name,
              model: opts.model ?? (ctx.config.model as string | undefined) ?? null,
              startedAt,
            });
          }
        } catch (err) {
          ctx.logger.warn(`failed to record agent call start: ${String(err)}`);
        }
        const report = (call: Omit<SettledAgentCall, "provider" | "startedAt" | "finishedAt">) => {
          // Accounting must never break the workflow.
          try {
            const settled = { provider: name, startedAt, finishedAt: Date.now(), ...call };
            if (typeof observe === "function") observe(settled);
            else observe?.settled(settled);
          } catch (err) {
            ctx.logger.warn(`failed to record agent call: ${String(err)}`);
          }
        };
        try {
          const rawResult = await provider.run(providerOpts, ctx);
          const result = opts.outputSchema
            ? await normalizeStructuredResult(opts.outputSchema, rawResult)
            : (rawResult as AgentResult<T>);
          report({
            id: callId,
            model: result.usage?.model ?? opts.model ?? null,
            status: "ok",
            usage: result.usage,
            error: null,
          });
          return result;
        } catch (err) {
          // An AgentCallError carries the usage burned before the failure
          // (e.g. a claude run aborted mid-stream) — record it, don't drop it.
          // Matched by name, not instanceof: a provider package may hold its
          // own copy of the class.
          const usage =
            err instanceof Error && err.name === "AgentCallError"
              ? (err as AgentCallError).usage
              : undefined;
          report({
            id: callId,
            model: usage?.model ?? opts.model ?? null,
            status:
              signal?.aborted && signal.reason instanceof Error && signal.reason.name === "TimeoutError"
                ? "timed_out"
                : signal?.aborted
                  ? "cancelled"
                  : "failed",
            usage,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
    };
  }
}
