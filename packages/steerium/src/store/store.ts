/**
 * Store interface + SQLite implementation. The interface is narrow on
 * purpose so a Postgres-backed store can be dropped in for server mode later
 * without touching the runtime.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentCallRecord,
  EventRecord,
  KeyValueState,
  RunEventRecord,
  RunRecord,
  RunStatus,
  RunStepRecord,
  StepStatus,
  StructuredError,
  WorkflowProvenance,
} from "../types.js";
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

type DatabaseSyncCtor = new (path: string) => DatabaseSync;

export interface NewRun {
  id: string;
  scope_id: string;
  workflow_name: string;
  trigger_kind: string | null;
  event_json: string;
  provenance?: WorkflowProvenance;
}

export interface NewStep {
  id: string;
  run_id: string;
  name: string;
}

/** A completed agent call, written once when the call settles (ok or error). */
export interface NewAgentCall {
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

export interface NewEvent {
  id: string;
  source: string;
  type: string;
  scope_id: string | null;
  workflow_name: string | null;
  dedupe_key: string | null;
  payload_json: string;
  raw_json: string | null;
  occurred_at: number | null;
}

/** Server-side filter for run listings (control API and CLI share it). */
export interface RunFilter {
  limit?: number;
  offset?: number;
  workflow?: string;
  status?: string;
}

export interface Store {
  // runs
  createRun(run: NewRun): void;
  startRun(id: string, at: number): void;
  finishRun(
    id: string,
    status: Exclude<RunStatus, "queued" | "running">,
    at: number,
    error?: StructuredError,
  ): void;
  getRun(id: string): RunRecord | undefined;
  listRuns(opts?: RunFilter): RunRecord[];
  countRuns(opts?: Pick<RunFilter, "workflow" | "status">): number;
  // steps
  startStep(step: NewStep, at: number): void;
  finishStep(
    id: string,
    status: Exclude<StepStatus, "running">,
    at: number,
    output_json?: string | null,
    error?: StructuredError,
    logs?: string | null,
  ): void;
  listSteps(runId: string): RunStepRecord[];
  // agent calls (token accounting)
  recordAgentCall(call: NewAgentCall): void;
  listAgentCalls(runId: string): AgentCallRecord[];
  appendRunEvent(runId: string, type: string, data: unknown, at?: number): RunEventRecord;
  listRunEvents(opts?: { after?: number; runId?: string; limit?: number }): RunEventRecord[];
  latestRunEventSeq(): number;
  subscribeRunEvents(listener: (event: RunEventRecord) => void): () => void;
  // events
  insertEvent(ev: NewEvent, received_at: number): void;
  findEventByDedupe(dedupe_key: string): EventRecord | undefined;
  /** Dedupe scoped to one workflow in one scope, so other listeners still fire. */
  findEventByDedupeScoped(
    dedupe_key: string,
    scope_id: string,
    workflow_name: string,
  ): EventRecord | undefined;
  listEvents(opts?: { limit?: number; workflow?: string }): EventRecord[];
  // kv (trigger cursors, shared workflow state)
  kvGet(namespace: string, key: string): unknown | undefined;
  kvSet(namespace: string, key: string, value: unknown): void;
  kvDelete(namespace: string, key: string): void;
  kvList(namespace: string): Array<{ key: string; value: unknown }>;
  /**
   * Mark queued/running work interrupted after a crash or hard kill. Returns
   * the number of runs recovered. Only call this when no other process owns runs.
   */
  recoverInterrupted(at: number): number;
  close(): void;
}

/**
 * Open a SQLite store. `node:sqlite` is imported dynamically here (not as a
 * static top-level import) so the runtime's experimental-warning suppression
 * has run first; a static import loads the module at link time, before any
 * user code executes.
 */
export async function openSqliteStore(path: string): Promise<SqliteStore> {
  const { DatabaseSync } = await import("node:sqlite");
  return new SqliteStore(path, DatabaseSync as unknown as DatabaseSyncCtor);
}

export class SqliteStore implements Store {
  private db: DatabaseSync;
  private runEventListeners = new Set<(event: RunEventRecord) => void>();

  constructor(path: string, DbCtor: DatabaseSyncCtor) {
    this.db = new DbCtor(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
    // A database created at an older version carries its version in kv; apply
    // the migrations between it and the current one. A fresh database (no
    // stored version) was just created by SCHEMA_SQL at the current shape.
    const stored = this.kvGet("__meta__", "schema_version") as number | undefined;
    if (stored !== undefined && stored > SCHEMA_VERSION) {
      // A newer binary created this database. Rewriting its version marker to
      // ours would make the newer binary re-run already-applied migrations on
      // the way back — refuse instead.
      this.db.close();
      throw new Error(
        `database at ${path} has schema version ${stored}, newer than this steerium build (version ${SCHEMA_VERSION}) — upgrade steerium or point STEERIUM_HOME elsewhere`,
      );
    }
    if (stored !== undefined && stored < SCHEMA_VERSION) {
      for (let v = stored + 1; v <= SCHEMA_VERSION; v++) {
        const sql = MIGRATIONS[v];
        if (sql) this.db.exec(sql);
      }
    }
    this.kvSet("__meta__", "schema_version", SCHEMA_VERSION);
  }

  createRun(run: NewRun): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, scope_id, workflow_name, trigger_kind, status, event_json, provenance_json, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(
        run.id,
        run.scope_id,
        run.workflow_name,
        run.trigger_kind,
        run.event_json,
        run.provenance ? JSON.stringify(run.provenance) : null,
        Date.now(),
      );
  }

  startRun(id: string, at: number): void {
    this.db.prepare(`UPDATE runs SET started_at = ?, status = 'running' WHERE id = ?`).run(at, id);
  }

  finishRun(
    id: string,
    status: Exclude<RunStatus, "queued" | "running">,
    at: number,
    error?: StructuredError,
  ): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, finished_at = ?, error = ?, error_code = ?, error_details_json = ? WHERE id = ?`,
      )
      .run(
        status,
        at,
        error?.message ?? null,
        error?.code ?? null,
        error?.details === undefined ? null : JSON.stringify(error.details),
        id,
      );
  }

  getRun(id: string): RunRecord | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as unknown as
      | RunRecord
      | undefined;
  }

  /** Build the WHERE clause + params shared by listRuns and countRuns. */
  private runsWhere(opts: Pick<RunFilter, "workflow" | "status">): {
    where: string;
    params: (string | number)[];
  } {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.workflow) {
      clauses.push("workflow_name = ?");
      params.push(opts.workflow);
    }
    if (opts.status) {
      clauses.push("status = ?");
      params.push(opts.status);
    }
    return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
  }

  listRuns(opts: RunFilter = {}): RunRecord[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const { where, params } = this.runsWhere(opts);
    return this.db
      .prepare(`SELECT * FROM runs${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as RunRecord[];
  }

  countRuns(opts: Pick<RunFilter, "workflow" | "status"> = {}): number {
    const { where, params } = this.runsWhere(opts);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM runs${where}`)
      .get(...params) as unknown as { n: number };
    return Number(row.n);
  }

  startStep(step: NewStep, at: number): void {
    this.db
      .prepare(
        `INSERT INTO run_steps (id, run_id, name, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(step.id, step.run_id, step.name, at);
  }

  finishStep(
    id: string,
    status: Exclude<StepStatus, "running">,
    at: number,
    output_json?: string | null,
    error?: StructuredError,
    logs?: string | null,
  ): void {
    this.db
      .prepare(
        `UPDATE run_steps SET status = ?, finished_at = ?, output_json = ?, error = ?, error_code = ?, error_details_json = ?, logs = ? WHERE id = ?`,
      )
      .run(
        status,
        at,
        output_json ?? null,
        error?.message ?? null,
        error?.code ?? null,
        error?.details === undefined ? null : JSON.stringify(error.details),
        logs ?? null,
        id,
      );
  }

  listSteps(runId: string): RunStepRecord[] {
    return this.db
      .prepare(`SELECT * FROM run_steps WHERE run_id = ? ORDER BY started_at ASC`)
      .all(runId) as unknown as RunStepRecord[];
  }

  recordAgentCall(call: NewAgentCall): void {
    this.db
      .prepare(
        `INSERT INTO agent_calls (id, run_id, step_id, provider, model, status,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           cost_usd, started_at, finished_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        call.id,
        call.run_id,
        call.step_id,
        call.provider,
        call.model,
        call.status,
        call.input_tokens,
        call.output_tokens,
        call.cache_read_tokens,
        call.cache_creation_tokens,
        call.cost_usd,
        call.started_at,
        call.finished_at,
        call.error,
      );
  }

  listAgentCalls(runId: string): AgentCallRecord[] {
    return this.db
      .prepare(`SELECT * FROM agent_calls WHERE run_id = ? ORDER BY started_at ASC`)
      .all(runId) as unknown as AgentCallRecord[];
  }

  appendRunEvent(runId: string, type: string, data: unknown, at = Date.now()): RunEventRecord {
    const id = randomUUID();
    const dataJson = JSON.stringify(data ?? null);
    const result = this.db
      .prepare(
        `INSERT INTO run_events (id, run_id, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, runId, type, dataJson, at);
    const event: RunEventRecord = {
      seq: Number(result.lastInsertRowid),
      id,
      run_id: runId,
      type,
      data_json: dataJson,
      created_at: at,
    };
    for (const listener of this.runEventListeners) {
      try {
        listener(event);
      } catch {
        // A disconnected stream must never break persistence or a workflow.
      }
    }
    return event;
  }

  listRunEvents(opts: { after?: number; runId?: string; limit?: number } = {}): RunEventRecord[] {
    const clauses = ["seq > ?"];
    const params: Array<string | number> = [opts.after ?? 0];
    if (opts.runId) {
      clauses.push("run_id = ?");
      params.push(opts.runId);
    }
    params.push(opts.limit ?? 1000);
    return this.db
      .prepare(`SELECT * FROM run_events WHERE ${clauses.join(" AND ")} ORDER BY seq ASC LIMIT ?`)
      .all(...params) as unknown as RunEventRecord[];
  }

  subscribeRunEvents(listener: (event: RunEventRecord) => void): () => void {
    this.runEventListeners.add(listener);
    return () => this.runEventListeners.delete(listener);
  }

  latestRunEventSeq(): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM run_events`).get() as {
      seq: number;
    };
    return Number(row.seq);
  }

  insertEvent(ev: NewEvent, received_at: number): void {
    this.db
      .prepare(
        `INSERT INTO events (id, source, type, scope_id, workflow_name, dedupe_key, payload_json, raw_json, occurred_at, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ev.id,
        ev.source,
        ev.type,
        ev.scope_id,
        ev.workflow_name,
        ev.dedupe_key,
        ev.payload_json,
        ev.raw_json,
        ev.occurred_at,
        received_at,
      );
  }

  findEventByDedupe(dedupe_key: string): EventRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM events WHERE dedupe_key = ? ORDER BY received_at DESC LIMIT 1`)
      .get(dedupe_key) as unknown as EventRecord | undefined;
  }

  findEventByDedupeScoped(
    dedupe_key: string,
    scope_id: string,
    workflow_name: string,
  ): EventRecord | undefined {
    return this.db
      .prepare(
        `SELECT * FROM events WHERE dedupe_key = ? AND scope_id = ? AND workflow_name = ?
         ORDER BY received_at DESC LIMIT 1`,
      )
      .get(dedupe_key, scope_id, workflow_name) as unknown as EventRecord | undefined;
  }

  listEvents(opts: { limit?: number; workflow?: string } = {}): EventRecord[] {
    const limit = opts.limit ?? 50;
    if (opts.workflow) {
      return this.db
        .prepare(`SELECT * FROM events WHERE workflow_name = ? ORDER BY received_at DESC LIMIT ?`)
        .all(opts.workflow, limit) as unknown as EventRecord[];
    }
    return this.db
      .prepare(`SELECT * FROM events ORDER BY received_at DESC LIMIT ?`)
      .all(limit) as unknown as EventRecord[];
  }

  kvGet(namespace: string, key: string): unknown | undefined {
    const row = this.db
      .prepare(`SELECT value_json FROM kv WHERE namespace = ? AND key = ?`)
      .get(namespace, key) as unknown as { value_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.value_json);
  }

  kvSet(namespace: string, key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv (namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(namespace, key, JSON.stringify(value ?? null), Date.now());
  }

  kvDelete(namespace: string, key: string): void {
    this.db.prepare(`DELETE FROM kv WHERE namespace = ? AND key = ?`).run(namespace, key);
  }

  kvList(namespace: string): Array<{ key: string; value: unknown }> {
    const rows = this.db
      .prepare(`SELECT key, value_json FROM kv WHERE namespace = ? ORDER BY key ASC`)
      .all(namespace) as unknown as Array<{ key: string; value_json: string }>;
    return rows.map((r) => ({ key: r.key, value: JSON.parse(r.value_json) }));
  }

  recoverInterrupted(at: number): number {
    const affected = this.db
      .prepare(`SELECT id FROM runs WHERE status IN ('queued', 'running')`)
      .all() as unknown as Array<{ id: string }>;
    const message = "interrupted: daemon stopped mid-run";
    this.db
      .prepare(
        `UPDATE run_steps SET status = 'interrupted', finished_at = ?, error = ?, error_code = 'interrupted'
         WHERE status = 'running'`,
      )
      .run(at, message);
    const res = this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', finished_at = ?, error = ?, error_code = 'interrupted'
         WHERE status IN ('queued', 'running')`,
      )
      .run(at, message);
    for (const { id } of affected) {
      this.appendRunEvent(
        id,
        "run.completed",
        { status: "interrupted", error: { code: "interrupted", message } },
        at,
      );
    }
    return Number(res.changes);
  }

  close(): void {
    this.runEventListeners.clear();
    this.db.close();
  }
}

/**
 * View one kv namespace as a KeyValueState. This is what backs trigger state
 * (`TriggerContext.state`), per-workflow state (`ctx.state`), and shared
 * namespaces (`ctx.kv(name)`) — they differ only in the namespace string.
 */
export function kvState(store: Store, namespace: string): KeyValueState {
  return {
    async get<T>(key: string) {
      return store.kvGet(namespace, key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      store.kvSet(namespace, key, value);
    },
    async delete(key: string) {
      store.kvDelete(namespace, key);
    },
    async list<T>() {
      return store.kvList(namespace) as Array<{ key: string; value: T }>;
    },
  };
}

/** Store namespace for a scope-shared kv namespace (`ctx.kv(name)`). */
export function sharedKvNamespace(scopeId: string, name: string): string {
  return `shared:${scopeId}:${name}`;
}
