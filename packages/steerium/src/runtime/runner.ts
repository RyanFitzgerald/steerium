/**
 * Runner. Executes one workflow against one event: creates the
 * run row (event stored for replay), runs the handler with step logging,
 * artifacts, concurrency cap, and timeout, then records a precise outcome.
 *
 * Events over the concurrency limit wait in a bounded per-workflow FIFO
 * (`queue`, default 10) and run as slots free; only events past the bound are
 * dropped, with a warning.
 *
 * No automatic retry; steps are logs-only, not durable.
 *
 * The runner resolves the providers + config for the run's *scope*, so
 * a project run uses that project's merged config (its provider/connector
 * overrides), not just the global one.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { artifactDir } from "../paths.js";
import type { ProviderRegistry } from "../providers/registry.js";
import { kvState, sharedKvNamespace, type Store } from "../store/store.js";
import type {
  Logger,
  RunStatus,
  Scope,
  SteeriumConfig,
  StructuredError,
  WorkflowContext,
  WorkflowDefinition,
} from "../types.js";
import { createArtifactWriter } from "./artifacts.js";
import { makeConnectorResolver } from "./connectors.js";
import { buildWorkflowProvenance } from "./provenance.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_QUEUE_DEPTH = 10;

/**
 * Tracks which `ctx.step` the current async execution belongs to, so agent
 * calls can be attributed to their step. AsyncLocalStorage (not a mutable
 * pointer) because steps legally run concurrently via Promise.all.
 */
const stepContext = new AsyncLocalStorage<{ stepId: string }>();

export interface ScopeRuntime {
  providers: ProviderRegistry;
  config: SteeriumConfig;
}

/** Resolve the providers + merged config that apply to a given scope. */
export type ScopeResolver = (scope: Scope) => ScopeRuntime;

export interface RunRequest {
  def: WorkflowDefinition<unknown>;
  scope: Scope;
  event: unknown;
  triggerKind: string;
  /** Source file captured by workflow discovery; inline callers may omit it. */
  workflowFile?: string;
}

export interface RunOutcome {
  runId: string;
  status: Exclude<RunStatus, "queued" | "running" | "interrupted">;
  error?: string;
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`run aborted after timeoutMs=${ms}`);
    this.name = "TimeoutError";
  }
}

class CancelledError extends Error {
  constructor() {
    super("run cancelled");
    this.name = "CancelledError";
  }
}

interface QueueEntry {
  req: RunRequest;
  runId: string;
  resolve: (outcome: RunOutcome) => void;
}

type FailureStatus = "failed" | "cancelled" | "timed_out";

function failure(
  error: unknown,
  signal?: AbortSignal,
): { status: FailureStatus; error: StructuredError } {
  const cause = signal?.aborted ? signal.reason : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return { status: "timed_out", error: { code: "timeout", message } };
  }
  if (signal?.aborted || (cause instanceof Error && cause.name === "CancelledError")) {
    return { status: "cancelled", error: { code: "cancelled", message } };
  }
  return {
    status: "failed",
    error: {
      code: cause instanceof Error ? cause.name.replace(/Error$/, "").toLowerCase() || "error" : "error",
      message,
    },
  };
}

export class Runner {
  private active = new Map<string, number>();
  private queues = new Map<string, QueueEntry[]>();
  /** Handler promises for runs currently executing (settles when the handler does). */
  private inFlight = new Set<Promise<unknown>>();
  /** Abort controller per executing run, so a run can be cancelled by id. */
  private controllers = new Map<string, AbortController>();
  private stopping = false;

  constructor(
    private store: Store,
    private resolveScope: ScopeResolver,
    private home: string,
    private logger: Logger,
  ) {}

  private concurrencyKey(scope: Scope, name: string): string {
    return `${scope.id}::${name}`;
  }

  private resolveConcurrency(def: WorkflowDefinition<unknown>, config: SteeriumConfig): number {
    return def.concurrency ?? config.defaults?.concurrency ?? 1;
  }

  private resolveTimeout(def: WorkflowDefinition<unknown>, config: SteeriumConfig): number {
    return def.timeoutMs ?? config.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private resolveQueueDepth(def: WorkflowDefinition<unknown>, config: SteeriumConfig): number {
    return def.queue ?? config.defaults?.queue ?? DEFAULT_QUEUE_DEPTH;
  }

  /**
   * Run the workflow, waiting in the bounded queue if at the concurrency limit.
   * The returned promise settles when the run itself finishes (queued or not).
   */
  async run(req: RunRequest): Promise<RunOutcome> {
    const { def, scope } = req;
    const { config } = this.resolveScope(scope);
    const runId = randomUUID();
    this.store.createRun({
      id: runId,
      scope_id: scope.id,
      workflow_name: def.name,
      trigger_kind: req.triggerKind,
      event_json: JSON.stringify(req.event ?? null),
      provenance: buildWorkflowProvenance(req.workflowFile, scope, config, def.name),
    });
    this.store.appendRunEvent(runId, "run.queued", {
      workflow: def.name,
      scopeId: scope.id,
      triggerKind: req.triggerKind,
    });
    if (this.stopping) {
      return this.drop(runId, "daemon shutting down");
    }
    const key = this.concurrencyKey(scope, def.name);
    const limit = this.resolveConcurrency(def, config);

    if ((this.active.get(key) ?? 0) >= limit) {
      const depth = this.resolveQueueDepth(def, config);
      const q = this.queues.get(key) ?? [];
      this.queues.set(key, q);
      if (q.length >= depth) {
        this.logger.warn(
          `dropping event for "${def.name}" in ${scope.id}: queue full (${q.length} waiting, limit ${limit} running)`,
        );
        return this.drop(runId, "workflow queue is full");
      }
      this.logger.info(
        `queueing event for "${def.name}" in ${scope.id} (${q.length + 1}/${depth} waiting)`,
      );
      return new Promise<RunOutcome>((resolve) => q.push({ req, runId, resolve }));
    }
    return this.execute(req, runId);
  }

  private drop(runId: string, message: string): RunOutcome {
    const at = Date.now();
    const error = { code: "dropped", message };
    this.store.finishRun(runId, "dropped", at, error);
    this.store.appendRunEvent(runId, "run.completed", { status: "dropped", error }, at);
    return { runId, status: "dropped", error: message };
  }

  /** Start the next queued event for this key if a slot is free. */
  private drain(key: string): void {
    if (this.stopping) return;
    const q = this.queues.get(key);
    if (!q?.length) return;
    const head = q[0]!;
    const { config } = this.resolveScope(head.req.scope);
    const limit = this.resolveConcurrency(head.req.def, config);
    if ((this.active.get(key) ?? 0) >= limit) return;
    q.shift();
    void this.execute(head.req, head.runId).then(head.resolve, (err) =>
      head.resolve({ runId: head.runId, status: "failed", error: String(err) }),
    );
  }

  /**
   * Cancel an executing run by aborting its signal. Same abort path as the
   * timeout: provider calls and subprocesses stop; un-abortable work winds
   * down in the background while the slot is held. False if the run is not
   * currently executing (finished, queued, or unknown).
   */
  cancel(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort(new CancelledError());
    return true;
  }

  /** Reject new work and drop everything still waiting in queues. */
  beginShutdown(): void {
    this.stopping = true;
    for (const q of this.queues.values()) {
      for (const entry of q.splice(0)) {
        this.logger.warn(
          `dropping queued event for "${entry.req.def.name}" in ${entry.req.scope.id}: daemon shutting down`,
        );
        entry.resolve(this.drop(entry.runId, "daemon shutting down"));
      }
    }
  }

  /** Wait up to graceMs for in-flight handlers to settle. True when idle. */
  async waitForIdle(graceMs: number): Promise<boolean> {
    const deadline = Date.now() + graceMs;
    while (this.inFlight.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((r) => setTimeout(r, Math.min(remaining, 250))),
      ]);
    }
    return true;
  }

  /** Execute one run. Assumes a free slot; takes it synchronously. */
  private async execute(req: RunRequest, runId: string): Promise<RunOutcome> {
    const { def, scope, event } = req;
    const { providers, config } = this.resolveScope(scope);

    const key = this.concurrencyKey(scope, def.name);
    this.active.set(key, (this.active.get(key) ?? 0) + 1);

    const runLog = this.logger.child({ run: runId, workflow: def.name });
    const started = Date.now();
    this.store.startRun(runId, started);
    this.store.appendRunEvent(runId, "run.started", { timeoutMs: this.resolveTimeout(def, config) }, started);

    const controller = new AbortController();
    this.controllers.set(runId, controller);
    const timeoutMs = this.resolveTimeout(def, config);
    const timer = setTimeout(() => controller.abort(new TimeoutError(timeoutMs)), timeoutMs);

    const ctx = this.buildContext(def, scope, event, runId, runLog, controller.signal, providers, config);
    // Capture the underlying handler promise so we can both race it against the
    // timeout *and* hold the concurrency slot until it truly settles.
    const runPromise = Promise.resolve().then(() => def.run(ctx));

    const settled = runPromise.catch(() => {});
    this.inFlight.add(settled);
    void settled.finally(() => this.inFlight.delete(settled));

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active.set(key, Math.max(0, (this.active.get(key) ?? 1) - 1));
      this.drain(key);
    };

    try {
      await this.withTimeout(runPromise, controller, timeoutMs);
      clearTimeout(timer);
      this.controllers.delete(runId);
      const finishedAt = Date.now();
      this.store.finishRun(runId, "ok", finishedAt);
      this.store.appendRunEvent(runId, "run.completed", {
        status: "ok",
        durationMs: finishedAt - started,
      }, finishedAt);
      runLog.info(`run ok (${finishedAt - started}ms)`);
      release();
      return { runId, status: "ok" };
    } catch (err) {
      clearTimeout(timer);
      this.controllers.delete(runId);
      const outcome = failure(err, controller.signal);
      const finishedAt = Date.now();
      this.store.finishRun(runId, outcome.status, finishedAt, outcome.error);
      this.store.appendRunEvent(runId, "run.completed", {
        status: outcome.status,
        error: outcome.error,
        durationMs: finishedAt - started,
      }, finishedAt);
      runLog.error(`run ${outcome.status}: ${outcome.error.message}`);
      // On timeout the handler may still be winding down (its provider calls and
      // subprocesses are aborted via the signal, but un-abortable work can't be
      // forced to stop). Hold the concurrency slot in the background until it
      // truly settles, so a timed-out run can't overlap its replacement — while
      // still returning the error to the caller promptly.
      void runPromise.catch(() => {}).finally(release);
      return { runId, status: outcome.status, error: outcome.error.message };
    }
  }

  private withTimeout<T>(p: Promise<T>, controller: AbortController, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason ?? new TimeoutError(ms));
      if (controller.signal.aborted) return onAbort();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          controller.signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e) => {
          controller.signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  private buildContext(
    def: WorkflowDefinition<unknown>,
    scope: Scope,
    event: unknown,
    runId: string,
    runLog: Logger,
    signal: AbortSignal,
    providers: ProviderRegistry,
    config: SteeriumConfig,
  ): WorkflowContext<unknown> {
    const store = this.store;
    const connector = makeConnectorResolver(config);
    const agent = providers.agentFor(scope, runLog, signal, {
      started(call) {
        store.appendRunEvent(runId, "agent.started", {
          callId: call.id,
          stepId: stepContext.getStore()?.stepId ?? null,
          provider: call.provider,
          model: call.model,
        }, call.startedAt);
      },
      settled(call) {
        const stepId = stepContext.getStore()?.stepId ?? null;
        store.recordAgentCall({
        id: call.id,
        run_id: runId,
        step_id: stepId,
        provider: call.provider,
        model: call.model,
        status: call.status,
        input_tokens: call.usage?.inputTokens ?? null,
        output_tokens: call.usage?.outputTokens ?? null,
        cache_read_tokens: call.usage?.cacheReadTokens ?? null,
        cache_creation_tokens: call.usage?.cacheCreationTokens ?? null,
        cost_usd: call.usage?.costUsd ?? null,
        started_at: call.startedAt,
        finished_at: call.finishedAt,
        error: call.error,
      });
        store.appendRunEvent(runId, "agent.completed", {
          callId: call.id,
          stepId,
          provider: call.provider,
          model: call.model,
          status: call.status,
          usage: call.usage,
          error: call.error,
          durationMs: call.finishedAt - call.startedAt,
        }, call.finishedAt);
      },
    });

    const step = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      const stepId = randomUUID();
      const stepStart = Date.now();
      store.startStep({ id: stepId, run_id: runId, name }, stepStart);
      store.appendRunEvent(runId, "step.started", { stepId, name }, stepStart);

      const logs: string[] = [];
      const stepLog = createLogger({
        bindings: { run: runId, step: name },
        sink: (line) => logs.push(line),
      });

      try {
        const result = await stepContext.run({ stepId }, () => Promise.resolve(fn()));
        let output_json: string | null = null;
        try {
          output_json = JSON.stringify(result ?? null);
        } catch {
          output_json = JSON.stringify({ unserializable: true });
        }
        const finishedAt = Date.now();
        store.finishStep(stepId, "ok", finishedAt, output_json, undefined, logs.join("\n") || null);
        store.appendRunEvent(runId, "step.completed", {
          stepId,
          name,
          status: "ok",
          durationMs: finishedAt - stepStart,
        }, finishedAt);
        return result;
      } catch (err) {
        const outcome = failure(err, signal);
        const finishedAt = Date.now();
        stepLog.error(outcome.error.message);
        store.finishStep(
          stepId,
          outcome.status,
          finishedAt,
          null,
          outcome.error,
          logs.join("\n") || null,
        );
        store.appendRunEvent(runId, "step.completed", {
          stepId,
          name,
          status: outcome.status,
          error: outcome.error,
          durationMs: finishedAt - stepStart,
        }, finishedAt);
        throw err;
      }
    };

    return {
      event,
      scope,
      logger: runLog,
      agent,
      runId,
      step,
      artifact: createArtifactWriter(artifactDir(this.home, runId), (artifact) => {
        store.appendRunEvent(runId, "artifact.written", {
          name: artifact.name,
          kind: artifact.kind,
        });
      }),
      connector,
      state: kvState(store, `workflow:${scope.id}:${def.name}`),
      kv: (namespace) => kvState(store, sharedKvNamespace(scope.id, namespace)),
      signal,
    };
  }
}
