/**
 * Core type surface for steerium. These are the public contracts the runtime,
 * built-ins, and third-party packages all program against.
 */

export type Promisable<T> = T | Promise<T>;

export type RunStatus =
  | "queued"
  | "running"
  | "ok"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted"
  | "dropped";

export type StepStatus =
  | "running"
  | "ok"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted";

export interface StructuredError {
  code: string;
  message: string;
  details?: unknown;
}

export interface WorkflowProvenance {
  steeriumVersion: string;
  nodeVersion: string;
  workflowFile: string;
  workflowHash: string;
  configFingerprint: string;
  git?: { sha: string; dirty: boolean };
}

/** A simple, redaction-aware logger handed to triggers and workflows. */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** Child logger that prefixes a scope/name onto every line. */
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * The context a workflow runs in. `global` runs at STEERIUM_HOME,
 * a project runs at its repo root.
 */
export interface Scope {
  readonly kind: "global" | "project";
  /** Stable id: "global" or "project:<absolute-path>". */
  readonly id: string;
  /** Working directory for the run (STEERIUM_HOME or the project root). */
  readonly cwd: string;
  /** Project root when kind === "project". */
  readonly projectRoot?: string;
}

/** Persistent key/value store scoped to a trigger, for dedup cursors. */
export interface TriggerState {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A TriggerState that can also enumerate its namespace. */
export interface KeyValueState extends TriggerState {
  list<T = unknown>(): Promise<Array<{ key: string; value: T }>>;
}

export interface TriggerContext {
  scope: Scope;
  logger: Logger;
  state: TriggerState;
  /**
   * A named, persistent key/value namespace shared within this scope. The same
   * name resolves to the same data from workflow runs (`ctx.kv`), so a trigger
   * can watch state that runs write (e.g. pending approvals).
   */
  kv(namespace: string): KeyValueState;
  /** Resolved connector config (secrets/settings) for the given connector. */
  connector<T = Record<string, unknown>>(name: string): T;
  /** Register an HTTP webhook route on the control server, returns the public path. */
  registerWebhook(path: string, handler: WebhookHandler): void;
}

/** Minimal request/response surface for connector webhook intake. */
export interface WebhookRequest {
  method: string;
  headers: Record<string, string>;
  /** Raw request body, used for signature verification. */
  rawBody: string;
  query: Record<string, string>;
}

export interface WebhookResponse {
  status: number;
  body?: string;
}

export type WebhookHandler = (req: WebhookRequest) => Promisable<WebhookResponse>;

export interface TriggerHandle {
  stop(): Promisable<void>;
}

export interface Trigger<E> {
  readonly kind: string;
  start(ctx: TriggerContext, emit: (event: E) => Promisable<void>): Promisable<TriggerHandle>;
}

export interface WorkflowDefinition<E = unknown> {
  name: string;
  on: Trigger<E>;
  run(ctx: WorkflowContext<E>): Promisable<void>;
  /** Max simultaneous runs of this workflow in its scope. Default 1. */
  concurrency?: number;
  /**
   * Max events waiting for a free slot when at the concurrency limit; events
   * past the bound are dropped with a warning. Default 10. Set 0 to restore
   * drop-on-overlap behavior.
   */
  queue?: number;
  /** Abort a run after this many ms. Default 5 min. */
  timeoutMs?: number;
  tags?: string[];
  // NOTE: no `retry` and no `policy` yet.
}

/** Writes files under the run's artifact dir (~/.steerium/artifacts/<runId>/). */
export interface ArtifactWriter {
  /** Absolute path to this run's artifact directory. */
  readonly dir: string;
  writeText(name: string, content: string): Promise<string>;
  writeJSON(name: string, value: unknown): Promise<string>;
  writeBytes(name: string, bytes: Uint8Array): Promise<string>;
}

export interface WorkflowContext<E = unknown> {
  event: E;
  scope: Scope;
  logger: Logger;
  agent: Agent;
  runId: string;
  /** Runs fn, records a run_steps row, returns its result. Logs-only. */
  step<T>(name: string, fn: () => Promisable<T>): Promise<T>;
  artifact: ArtifactWriter;
  connector<T = unknown>(name: string): T;
  /**
   * Persistent key/value state private to this workflow (per scope). Survives
   * across runs — cursors, "last processed" markers, and the like.
   */
  state: KeyValueState;
  /**
   * A named, persistent key/value namespace shared within this scope. The same
   * name resolves to the same data from other workflows and from triggers
   * (`TriggerContext.kv`), which is how two workflows hand state to each other.
   */
  kv(namespace: string): KeyValueState;
  /** True once the run has exceeded its timeout; long steps should check it. */
  signal: AbortSignal;
}

/** Structural schema surface implemented by Standard Schema libraries such as Zod 4. */
export interface StandardOutputSchema<T = unknown> {
  readonly "~standard": {
    readonly version: 1;
    readonly validate: (value: unknown) => Promisable<
      { value: T; issues?: undefined } | { issues: readonly unknown[] }
    >;
    readonly jsonSchema?: {
      readonly output: (options?: { target?: string }) => Record<string, unknown>;
    };
  };
}

export type AgentOutputSchema<T = unknown> = Record<string, unknown> | StandardOutputSchema<T>;

export interface AgentRunOptions<T = unknown> {
  /** Provider name; defaults to config.defaults.provider. */
  provider?: string;
  prompt: string;
  system?: string;
  /** Working directory; defaults to scope.cwd. */
  cwd?: string;
  model?: string;
  maxTokens?: number;
  // Agent providers additionally accept (passthrough to the SDK):
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
  allowedTools?: string[];
  /** JSON schema for structured output, where the provider supports it. */
  outputSchema?: AgentOutputSchema<T>;
}

/**
 * Normalized token usage for one agent call. Fields are disjoint (Anthropic
 * semantics): inputTokens excludes cache reads/writes, so the grand total is
 * the sum of all four — matching ccusage's totalTokens and OpenAI's
 * total_tokens. Providers whose input count includes cached tokens (OpenAI)
 * must subtract the cached portion when mapping. Absent fields mean the
 * provider did not report that number; an absent `usage` altogether means
 * "unknown", which is distinct from zero.
 */
export interface AgentUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** Provider-reported cost only (e.g. Claude Agent SDK total_cost_usd). Never computed from a price table. */
  costUsd?: number;
  /** Model that actually served the call, as reported by the provider. */
  model?: string;
}

export interface AgentResult<T = unknown> {
  text: string;
  /** Parsed and validated structured output when outputSchema was requested. */
  data?: T;
  /** Normalized token usage, when the provider reports it. */
  usage?: AgentUsage;
  /** Provider-specific payload (events, usage, threadId, ...). */
  raw?: unknown;
}

/** The handle a workflow uses to make AI/agent calls. */
export interface Agent {
  run<T = unknown>(opts: AgentRunOptions<T>): Promise<AgentResult<T>>;
}

export interface ProviderContext {
  scope: Scope;
  logger: Logger;
  /** Resolved per-provider config from SteeriumConfig.providers[name]. */
  config: ProviderConfig;
  /**
   * Aborted when the owning run hits its timeout. Providers must forward this
   * to their HTTP client / subprocess so in-flight work actually stops.
   */
  signal?: AbortSignal;
}

export interface Provider {
  readonly name: string;
  /** Must be explicitly true before outputSchema is forwarded to this provider. */
  readonly supportsStructuredOutput?: boolean;
  run(opts: AgentRunOptions, ctx: ProviderContext): Promise<AgentResult>;
  /**
   * Optional health probe for `steerium doctor`. Returns which auth method
   * resolved, or throws/returns an error string if misconfigured.
   */
  health?(ctx: ProviderContext): Promisable<ProviderHealth>;
}

export interface ProviderHealth {
  ok: boolean;
  /** e.g. "api-key", "subscription", "mock", "missing". */
  auth: string;
  detail?: string;
}

/** A secret reference resolved from the environment. */
export interface EnvRef {
  env: string;
}

export type Secret = string | EnvRef;

export interface ProviderConfig {
  /** Default model for this provider. */
  model?: string;
  /** API key (string or { env }). Providers also fall back to their own env var. */
  apiKey?: Secret;
  /** Default permission mode for agent providers. */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
  /** Default allowed tools for agent providers. */
  allowedTools?: string[];
  /** Extra provider-specific settings. */
  [key: string]: unknown;
}

export interface SteeriumConfig {
  /** Custom or overridden providers, keyed by name. Built-ins are auto-registered. */
  providers?: Record<string, ProviderConfig | Provider>;
  /** Per-connector secrets/settings. */
  connectors?: Record<string, Record<string, unknown>>;
  /** Project roots to load. */
  projects?: string[];
  defaults?: {
    provider?: string;
    concurrency?: number;
    timeoutMs?: number;
    /** Default queue depth per workflow when at the concurrency limit. */
    queue?: number;
    /** How long shutdown waits for in-flight runs before closing. Default 30s. */
    shutdownGraceMs?: number;
  };
  /** Control server binding. Localhost by default. */
  control?: {
    port?: number;
    host?: string;
    token?: string;
    ui?: boolean;
    /** Maximum JSON/webhook request body size. Default 1 MiB. */
    maxBodyBytes?: number;
  };
}

/** A run record persisted in the store. */
export interface RunRecord {
  id: string;
  scope_id: string;
  workflow_name: string;
  trigger_kind: string | null;
  status: RunStatus;
  event_json: string;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  error_code: string | null;
  error_details_json: string | null;
  provenance_json: string | null;
  created_at: number;
}

export interface RunStepRecord {
  id: string;
  run_id: string;
  name: string;
  status: StepStatus;
  started_at: number | null;
  finished_at: number | null;
  output_json: string | null;
  error: string | null;
  error_code: string | null;
  error_details_json: string | null;
  logs: string | null;
}

/**
 * One `ctx.agent.run` call persisted in the store. `step_id` is null for
 * calls made outside any `ctx.step`. Token columns are null when the provider
 * did not report usage — render that as "unknown", never as 0.
 */
export interface AgentCallRecord {
  id: string;
  run_id: string;
  step_id: string | null;
  provider: string;
  model: string | null;
  status: "ok" | "failed" | "cancelled" | "timed_out";
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  started_at: number;
  finished_at: number;
  error: string | null;
}

export interface RunEventRecord {
  seq: number;
  id: string;
  run_id: string;
  type: string;
  data_json: string;
  created_at: number;
}

export interface EventRecord {
  id: string;
  source: string;
  type: string;
  scope_id: string | null;
  workflow_name: string | null;
  dedupe_key: string | null;
  payload_json: string;
  raw_json: string | null;
  occurred_at: number | null;
  received_at: number;
}
