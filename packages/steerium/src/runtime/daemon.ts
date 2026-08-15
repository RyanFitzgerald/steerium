/**
 * Daemon. Loads config, discovers and loads workflows, registers
 * and starts triggers, normalizes and dedups events, runs workflows, serves the
 * control API, and shuts down gracefully (stops all trigger handles).
 *
 * Config is resolved *per scope*: the global scope uses the
 * global config; each project scope uses its config merged over the global one
 * (project wins), so project provider/connector overrides take effect.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendReply,
  APPROVALS_NAMESPACE,
  normalizeApprovalRecord,
  type ApprovalRecord,
} from "../approvals.js";
import { createLogger } from "../logger.js";
import { artifactDir, homePaths } from "../paths.js";
import { ProviderRegistry } from "../providers/registry.js";
import { globalScope, projectScope } from "../scope.js";
import { kvState, openSqliteStore, sharedKvNamespace, type Store } from "../store/store.js";
import type {
  Logger,
  Scope,
  SteeriumConfig,
  TriggerContext,
  TriggerHandle,
} from "../types.js";
import { loadGlobalConfig, loadProjectConfig } from "../config/load.js";
import {
  loadAllWorkflows,
  loadProjectWorkflows,
  type LoadedWorkflow,
} from "../config/workflows.js";
import { makeConnectorResolver } from "./connectors.js";
import {
  ControlServer,
  type ApprovalListing,
  type ArtifactInfo,
  type FireResult,
  type RespondResult,
  type WorkflowSummary,
} from "./control-api.js";
import { Runner, type ScopeRuntime } from "./runner.js";

interface NormalizedEvent {
  source: string;
  type: string;
  dedupe_key: string | null;
  occurred_at: number | null;
}

function normalizeEvent(event: unknown): NormalizedEvent {
  const e = (event ?? {}) as Record<string, unknown>;
  const source = typeof e["source"] === "string" ? (e["source"] as string) : "manual";
  const type = typeof e["type"] === "string" ? (e["type"] as string) : "event";
  // Connectors may set an explicit dedupeKey; ticket events get a derived one;
  // schedule/manual stay null.
  let dedupe_key: string | null = null;
  const ticket = e["ticket"] as Record<string, unknown> | undefined;
  if (typeof e["dedupeKey"] === "string") {
    dedupe_key = e["dedupeKey"] as string;
  } else if (ticket && typeof ticket["id"] === "string") {
    dedupe_key = `${source}:${ticket["id"]}:${ticket["status"] ?? ""}`;
  }
  return { source, type, dedupe_key, occurred_at: null };
}

const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

export interface DaemonOptions {
  /** Skip starting trigger producers (used for one-shot CLI commands). */
  triggersDisabled?: boolean;
  /**
   * Project-scoped mode: load only this project's workflows and its merged
   * config. State, artifacts, and the global config base still come from
   * STEERIUM_HOME. Global workflows do not run in this mode.
   */
  projectRoot?: string;
}

/** One registered project as the daemon resolved it at startup. */
export interface ProjectInfo {
  root: string;
  /** false when the registered root no longer exists on disk (skipped). */
  exists: boolean;
  /** Number of workflows loaded from the project's .steerium/workflows/. */
  workflows: number;
}

/** Snapshot served at GET /status so `steerium status` can show what a running daemon actually loaded. */
export interface DaemonInfo {
  pid: number;
  startedAt: number;
  mode: "global" | "project";
  projectRoot?: string;
  projects: ProjectInfo[];
  workflows: number;
}

export class Daemon {
  private store!: Store;
  private runner!: Runner;
  private control!: ControlServer;
  private logger: Logger;
  private config!: SteeriumConfig;
  private workflows: LoadedWorkflow[] = [];
  private handles: TriggerHandle[] = [];
  private home: string;
  private projectRoots: Array<{ root: string; exists: boolean }> = [];
  private startedAt = Date.now();

  /** Per-scope merged config + provider registry, keyed by scope id. */
  private scopeRuntimes = new Map<string, ScopeRuntime>();

  constructor(private opts: DaemonOptions = {}) {
    this.logger = createLogger({ bindings: { mod: "daemon" } });
    this.home = homePaths().home;
  }

  /** Load config + workflows and build the store/providers/runner (no I/O servers yet). */
  async init(): Promise<void> {
    const paths = homePaths();
    mkdirSync(paths.home, { recursive: true });
    mkdirSync(paths.artifactsDir, { recursive: true });
    mkdirSync(paths.logsDir, { recursive: true });

    const { global } = await loadGlobalConfig();
    this.config = global;
    this.store = await openSqliteStore(paths.db);

    // Recover runs orphaned by a previous crash/kill. Only safe when this
    // process will own execution — one-shot CLI daemons must not touch runs a
    // live daemon may still be executing.
    if (!this.opts.triggersDisabled) {
      const recovered = this.store.recoverInterrupted(Date.now());
      if (recovered > 0) {
        this.logger.warn(`recovered ${recovered} run(s) left 'running' by a previous process`);
      }
    }

    // Global scope runtime (always present as the fallback).
    this.scopeRuntimes.set(globalScope(this.home).id, {
      config: global,
      providers: new ProviderRegistry(global),
    });

    if (this.opts.projectRoot) {
      // Project-scoped mode: one project, registered or not.
      const root = this.opts.projectRoot;
      if (!existsSync(root)) throw new Error(`project root does not exist: ${root}`);
      const merged = await loadProjectConfig(global, root);
      this.scopeRuntimes.set(projectScope(root).id, {
        config: merged,
        providers: new ProviderRegistry(merged),
      });
      this.projectRoots = [{ root, exists: true }];
      this.workflows = await loadProjectWorkflows(root);
      // The project's merged config drives the control server too, so a
      // project can pin its own port.
      this.config = merged;
    } else {
      // One merged-config runtime per registered project.
      for (const root of global.projects ?? []) {
        this.projectRoots.push({ root, exists: existsSync(root) });
        if (!existsSync(root)) continue;
        const merged = await loadProjectConfig(global, root);
        this.scopeRuntimes.set(projectScope(root).id, {
          config: merged,
          providers: new ProviderRegistry(merged),
        });
      }
      this.workflows = await loadAllWorkflows(global);
    }

    this.runner = new Runner(this.store, (scope) => this.runtimeFor(scope), this.home, this.logger);

    this.control = new ControlServer(
      {
        listWorkflows: () => this.summaries(),
        listRuns: (filter) => this.store.listRuns(filter),
        countRuns: (filter) => this.store.countRuns(filter),
        getRun: (id) => {
          const run = this.store.getRun(id);
          return run
            ? {
                run,
                steps: this.store.listSteps(id),
                agentCalls: this.store.listAgentCalls(id),
                events: this.store.listRunEvents({ runId: id }),
              }
            : undefined;
        },
        listRunEvents: (opts) => this.store.listRunEvents(opts),
        latestRunEventSeq: () => this.store.latestRunEventSeq(),
        subscribeRunEvents: (listener) => this.store.subscribeRunEvents(listener),
        fire: (name, input, projectRoot) => this.fire(name, input, projectRoot),
        replay: (runId) => this.replay(runId),
        cancel: (runId) => this.runner.cancel(runId),
        listArtifacts: (runId) => this.listArtifacts(runId),
        artifactFile: (runId, rel) => this.artifactFile(runId, rel),
        listApprovals: () => this.listApprovals(),
        respondApproval: (id, text, user, scopeId, requestId) =>
          this.respondApproval(id, text, user, scopeId, requestId),
        status: () => this.info(),
      },
      {
        host: this.config.control?.host ?? "127.0.0.1",
        port: this.config.control?.port ?? 4319,
        token: this.config.control?.token,
        maxBodyBytes: this.config.control?.maxBodyBytes,
        ui: this.config.control?.ui !== false,
        // The prebuilt SPA ships at dist/ui, next to dist/runtime/. Absent in
        // dev (tsx over src/) — the inline UI_HTML fallback serves instead.
        uiDir: fileURLToPath(new URL("../ui", import.meta.url)),
        logger: this.logger.child({ mod: "control" }),
      },
    );
  }

  /** Resolve the providers + config for a scope, falling back to global. */
  private runtimeFor(scope: Scope): ScopeRuntime {
    const hit = this.scopeRuntimes.get(scope.id);
    if (hit) return hit;
    const fallback = this.scopeRuntimes.get(globalScope(this.home).id);
    if (fallback) return fallback;
    // Last resort (e.g. a project scope discovered late): build from global.
    return { config: this.config, providers: new ProviderRegistry(this.config) };
  }

  private summaries(): WorkflowSummary[] {
    return this.workflows.map((w) => ({
      name: w.def.name,
      triggerKind: w.def.on.kind,
      scopeId: w.scope.id,
      tags: w.def.tags,
    }));
  }

  /** Public view of loaded workflows, for CLI listing without a running daemon. */
  listWorkflowSummaries(): WorkflowSummary[] {
    return this.summaries();
  }

  /**
   * What this daemon resolved at startup: mode, registered projects (and
   * whether each contributed workflows), and the loaded workflow count.
   * Projects registered after startup are not here — that's the point: this
   * is how `steerium status` proves what a running daemon picked up.
   */
  info(): DaemonInfo {
    const counts = new Map<string, number>();
    for (const w of this.workflows) {
      counts.set(w.scope.id, (counts.get(w.scope.id) ?? 0) + 1);
    }
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      mode: this.opts.projectRoot ? "project" : "global",
      projectRoot: this.opts.projectRoot,
      projects: this.projectRoots.map((p) => ({
        ...p,
        workflows: counts.get(projectScope(p.root).id) ?? 0,
      })),
      workflows: this.workflows.length,
    };
  }

  getStore(): Store {
    return this.store;
  }

  /** Files a run wrote under artifacts/<runId>/, relative paths + size/mtime. */
  private listArtifacts(runId: string): ArtifactInfo[] {
    const dir = artifactDir(this.home, runId);
    if (!existsSync(dir)) return [];
    const out: ArtifactInfo[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const st = statSync(full);
          out.push({ path: relative(dir, full), size: st.size, mtime: Math.round(st.mtimeMs) });
        }
      }
    };
    walk(dir);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Resolve one artifact to an absolute path, refusing paths that escape the run dir. */
  private artifactFile(runId: string, rel: string): string | undefined {
    const dir = artifactDir(this.home, runId);
    const file = resolve(dir, rel);
    if (file !== dir && !file.startsWith(dir + sep)) return undefined;
    if (!existsSync(file) || !statSync(file).isFile()) return undefined;
    return file;
  }

  /** Approvals across every scope this daemon loaded, pending first, newest first. */
  private listApprovals(): ApprovalListing[] {
    const out: ApprovalListing[] = [];
    for (const scopeId of this.scopeRuntimes.keys()) {
      const ns = sharedKvNamespace(scopeId, APPROVALS_NAMESPACE);
      for (const { value } of this.store.kvList(ns)) {
        out.push({ scopeId, approval: normalizeApprovalRecord(value as ApprovalRecord) });
      }
    }
    return out.sort(
      (a, b) =>
        Number(b.approval.status === "pending") - Number(a.approval.status === "pending") ||
        b.approval.updatedAt - a.approval.updatedAt,
    );
  }

  /**
   * Record a human reply on a pending approval. The reply lands on the kv
   * record; the `approvals.responded()` poll trigger turns it into an event.
   */
  private respondApproval(
    id: string,
    text: string,
    user?: string,
    scopeId?: string,
    requestId?: string,
  ): RespondResult {
    const scopes = scopeId ? [scopeId] : [...this.scopeRuntimes.keys()];
    for (const sid of scopes) {
      const ns = sharedKvNamespace(sid, APPROVALS_NAMESPACE);
      const stored = this.store.kvGet(ns, id) as ApprovalRecord | undefined;
      if (!stored) continue;
      const record = normalizeApprovalRecord(stored);
      if (record.status !== "pending") {
        return { ok: false, status: 409, error: `approval "${id}" is ${record.status}` };
      }
      if (!requestId && record.rounds > 1) {
        return { ok: false, status: 409, error: "requestId is required after the first round" };
      }
      if (requestId && requestId !== record.requestId) {
        return { ok: false, status: 409, error: "reply targets a stale approval request" };
      }
      if (!record.allowFreeform && !record.options?.some((option) => option.value === text)) {
        return { ok: false, status: 400, error: "reply must select one of the approval options" };
      }
      this.store.kvSet(ns, id, appendReply(record, text, user, requestId));
      return { ok: true };
    }
    return { ok: false, status: 404, error: `unknown approval "${id}"` };
  }

  private triggerContext(wf: LoadedWorkflow): TriggerContext {
    // Connector config comes from the workflow's own scope (project overrides).
    const connector = makeConnectorResolver(this.runtimeFor(wf.scope).config);
    const namespace = `trigger:${wf.scope.id}:${wf.def.name}:${wf.def.on.kind}`;
    return {
      scope: wf.scope,
      logger: this.logger.child({ trigger: wf.def.on.kind, workflow: wf.def.name }),
      state: kvState(this.store, namespace),
      kv: (name) => kvState(this.store, sharedKvNamespace(wf.scope.id, name)),
      connector,
      // Webhook routes are keyed by (connector path, workflow) so multiple
      // workflows can listen to the same connector without clobbering handlers.
      registerWebhook: (path, handler) =>
        this.control.registerWebhook(path, handler, `${wf.scope.id}:${wf.def.name}`),
    };
  }

  /**
   * Persist + dedup an event, then run the workflow. Shared by triggers and
   * manual fires so every run has a corresponding events row.
   * Dedup is scoped to (workflow, scope) so other listeners still fire.
   */
  private async recordEventAndRun(
    wf: LoadedWorkflow,
    event: unknown,
    triggerKind: string,
  ): Promise<FireResult> {
    const norm = normalizeEvent(event);
    if (norm.dedupe_key) {
      const existing = this.store.findEventByDedupeScoped(norm.dedupe_key, wf.scope.id, wf.def.name);
      if (existing) {
        this.logger.warn(
          `dedup: skipping ${norm.dedupe_key} for ${wf.def.name} in ${wf.scope.id} (already seen)`,
        );
        return { runId: "", status: "skipped" };
      }
    }
    this.store.insertEvent(
      {
        id: randomUUID(),
        source: norm.source,
        type: norm.type,
        scope_id: wf.scope.id,
        workflow_name: wf.def.name,
        dedupe_key: norm.dedupe_key,
        payload_json: JSON.stringify(event ?? null),
        raw_json:
          event && typeof event === "object" && "raw" in (event as object)
            ? JSON.stringify((event as { raw: unknown }).raw ?? null)
            : null,
        occurred_at: norm.occurred_at,
      },
      Date.now(),
    );
    const outcome = await this.runner.run({
      def: wf.def,
      scope: wf.scope,
      event,
      triggerKind,
      workflowFile: wf.file,
    });
    return { runId: outcome.runId, status: outcome.status, error: outcome.error };
  }

  /** Start the control server and all trigger producers. */
  async start(): Promise<void> {
    await this.control.start();

    if (this.opts.triggersDisabled) return;

    for (const wf of this.workflows) {
      // Manual triggers are inert producers; fired via fire()/control API.
      if (wf.def.on.kind === "manual") continue;
      try {
        const handle = await wf.def.on.start(this.triggerContext(wf), (event) =>
          this.recordEventAndRun(wf, event, wf.def.on.kind).then(() => undefined),
        );
        this.handles.push(handle);
        this.logger.info(`started trigger`, {
          workflow: wf.def.name,
          kind: wf.def.on.kind,
          scope: wf.scope.id,
        });
      } catch (err) {
        this.logger.error(`failed to start trigger for ${wf.def.name}: ${String(err)}`);
      }
    }
    this.logger.info(`daemon ready: ${this.workflows.length} workflow(s) loaded`);
  }

  /**
   * Fire a workflow once with an optional manual input payload. The event is
   * always shaped as a ManualEvent ({ source: "manual", input }) so a workflow
   * bound to `manual()` reads its payload from `ctx.event.input` as typed.
   */
  async fire(name: string, input: unknown, projectRoot?: string): Promise<FireResult> {
    const wf = this.findWorkflow(name, projectRoot);
    if (!wf) return { runId: "", status: "error", error: `unknown workflow "${name}"` };
    // An empty object from the CLI/UI ("no input") is normalized to undefined.
    const payload =
      input && typeof input === "object" && Object.keys(input).length === 0 ? undefined : input;
    const event = { source: "manual" as const, input: payload };
    return this.recordEventAndRun(wf, event, "manual");
  }

  /**
   * Replay a run against its stored event. Replay always runs — it
   * deliberately bypasses dedup and does not record a new received-event row,
   * because it is re-running an event already received, not a new one.
   */
  async replay(runId: string): Promise<FireResult> {
    const run = this.store.getRun(runId);
    if (!run) return { runId: "", status: "error", error: `unknown run "${runId}"` };
    const wf = this.findWorkflowForScope(run.workflow_name, run.scope_id);
    if (!wf) {
      return { runId: "", status: "error", error: `workflow "${run.workflow_name}" not loaded` };
    }
    const event = JSON.parse(run.event_json);
    const outcome = await this.runner.run({
      def: wf.def,
      scope: wf.scope,
      event,
      triggerKind: run.trigger_kind ?? "replay",
      workflowFile: wf.file,
    });
    return { runId: outcome.runId, status: outcome.status, error: outcome.error };
  }

  private findWorkflow(name: string, projectRoot?: string): LoadedWorkflow | undefined {
    if (projectRoot) {
      const scopeId = projectScope(projectRoot).id;
      const scoped = this.workflows.find((w) => w.def.name === name && w.scope.id === scopeId);
      if (scoped) return scoped;
    }
    return this.workflows.find((w) => w.def.name === name);
  }

  private findWorkflowForScope(name: string, scopeId: string): LoadedWorkflow | undefined {
    return (
      this.workflows.find((w) => w.def.name === name && w.scope.id === scopeId) ??
      this.findWorkflow(name)
    );
  }

  /**
   * Graceful shutdown: stop trigger producers (no new events), drop queued
   * events, wait up to the grace period for in-flight runs to finish, then
   * stop the control server and close the store. Runs still active when the
   * grace expires are marked interrupted so they don't linger as 'running'.
   */
  async shutdown(): Promise<void> {
    this.logger.info("shutting down: stopping triggers");
    await Promise.allSettled(this.handles.map((h) => Promise.resolve(h.stop())));
    this.runner.beginShutdown();

    const graceMs = this.config.defaults?.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    const idle = await this.runner.waitForIdle(graceMs);
    if (!idle) {
      this.logger.warn(
        `shutdown grace (${graceMs}ms) expired with runs still active; marking them interrupted`,
      );
    }
    await this.control.stop();
    if (!idle) this.store.recoverInterrupted(Date.now());
    this.store.close();
  }

  controlUrl(): string {
    return this.control.url;
  }
}
