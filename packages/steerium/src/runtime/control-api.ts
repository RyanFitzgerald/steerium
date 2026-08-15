/**
 * Control API. A localhost HTTP server. The CLI is a client of it; the
 * browser UI is another client of the same API. Built on Node's http module so
 * the core stays dependency-light.
 *
 * Binds to 127.0.0.1 by default and is unauthenticated locally. Exposing
 * it on a non-local host requires a token; without one it refuses non-local
 * connections.
 *
 * The UI at "/" is served from `uiDir` (the prebuilt SPA shipped in dist/ui)
 * when present, falling back to the self-contained UI_HTML page — the UI is
 * never load-bearing.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { ApprovalRecord } from "../approvals.js";
import type { RunFilter } from "../store/store.js";
import type { Logger, RunEventRecord, WebhookHandler, WebhookRequest } from "../types.js";
import { UI_HTML } from "./ui.js";

export interface WorkflowSummary {
  name: string;
  triggerKind: string;
  scopeId: string;
  tags?: string[];
}

export interface FireResult {
  runId: string;
  status: string;
  error?: string;
}

/** One approval as listed at GET /approvals, tagged with the scope it lives in. */
export interface ApprovalListing {
  scopeId: string;
  approval: ApprovalRecord;
}

/** Outcome of recording a reply via POST /approvals/:id/respond. */
export interface RespondResult {
  ok: boolean;
  /** HTTP status to surface when not ok (404 unknown, 409 not pending). */
  status?: number;
  error?: string;
}

/** One file written by a run, as listed at GET /runs/:id/artifacts. */
export interface ArtifactInfo {
  /** Path relative to the run's artifact dir (what writeText was given). */
  path: string;
  size: number;
  mtime: number;
}

export interface ControlDeps {
  listWorkflows(): WorkflowSummary[];
  listRuns(filter: RunFilter): unknown[];
  countRuns(filter: Pick<RunFilter, "workflow" | "status">): number;
  getRun(id: string):
    | { run: unknown; steps: unknown[]; agentCalls: unknown[]; events: RunEventRecord[] }
    | undefined;
  listRunEvents(opts?: { after?: number; runId?: string; limit?: number }): RunEventRecord[];
  latestRunEventSeq(): number;
  subscribeRunEvents(listener: (event: RunEventRecord) => void): () => void;
  fire(name: string, input: unknown, projectRoot?: string): Promise<FireResult>;
  replay(runId: string): Promise<FireResult>;
  /** Abort an executing run. False when it isn't currently executing. */
  cancel(runId: string): boolean;
  listArtifacts(runId: string): ArtifactInfo[];
  /** Absolute path of one artifact, or undefined if missing / outside the run dir. */
  artifactFile(runId: string, rel: string): string | undefined;
  /** Approvals across all scopes this daemon loaded, pending first. */
  listApprovals(): ApprovalListing[];
  /** Record a human reply on a pending approval (the UI/CLI response path). */
  respondApproval(
    id: string,
    text: string,
    user?: string,
    scopeId?: string,
    requestId?: string,
  ): RespondResult;
  /** Startup snapshot (mode, projects, workflow count) served at GET /status. */
  status(): unknown;
}

export interface ControlServerOptions {
  host: string;
  port: number;
  token?: string;
  /** Maximum accepted request body size. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Serve the browser UI at "/". Default true. */
  ui?: boolean;
  /** Directory of the prebuilt SPA (dist/ui). Fallback is the inline UI_HTML. */
  uiDir?: string;
  logger: Logger;
}

function isLocal(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

function parseRunFilter(url: URL): RunFilter {
  const filter: RunFilter = { limit: Number(url.searchParams.get("limit") ?? "50") };
  const offset = url.searchParams.get("offset");
  if (offset) filter.offset = Number(offset);
  const workflow = url.searchParams.get("workflow");
  if (workflow) filter.workflow = workflow;
  const status = url.searchParams.get("status");
  if (status) filter.status = status;
  return filter;
}

const SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

class PayloadTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
  }
}

export class ControlServer {
  private server?: Server;
  /**
   * Each connector path can have multiple handlers — one per workflow listening
   * to it — so registering a second workflow doesn't clobber the first. Keyed
   * by an owner id within the path's handler list.
   */
  private webhooks = new Map<string, Map<string, WebhookHandler>>();
  /** Open SSE responses, so stop() can end them (they'd otherwise hold close()). */
  private streams = new Set<ServerResponse>();

  constructor(
    private deps: ControlDeps,
    private opts: ControlServerOptions,
  ) {}

  /** Register a webhook handler for a path on behalf of one owner (workflow). */
  registerWebhook(path: string, handler: WebhookHandler, owner = "default"): void {
    let byOwner = this.webhooks.get(path);
    if (!byOwner) {
      byOwner = new Map();
      this.webhooks.set(path, byOwner);
    }
    byOwner.set(owner, handler);
    this.opts.logger.info(`registered webhook route ${path} for ${owner}`);
  }

  get url(): string {
    return `http://${this.opts.host}:${this.opts.port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.opts.port, this.opts.host, () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });
    this.opts.logger.info(`control API listening on ${this.url}`);
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    for (const res of this.streams) res.end();
    this.streams.clear();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    const limit = this.opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > limit) throw new PayloadTooLargeError(limit);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) throw new PayloadTooLargeError(limit);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
    res.end(payload);
  }

  /** Token gate: when bound to a non-local host, a matching token is required. */
  private authorized(req: IncomingMessage): boolean {
    if (isLocal(this.opts.host)) return true;
    if (!this.opts.token) return false;
    const expected = createHash("sha256").update(`Bearer ${this.opts.token}`).digest();
    const actual = createHash("sha256")
      .update(req.headers["authorization"] ?? "")
      .digest();
    return timingSafeEqual(actual, expected);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", this.url);
      const path = url.pathname;
      const method = req.method ?? "GET";

      // Webhook intake is signature-verified by the connector handler itself,
      // which is the protection for this unauthenticated, externally-reachable
      // route. A handler that can't verify the payload returns 401.
      if (path.startsWith("/webhooks/")) return await this.handleWebhook(req, res, path);

      if (!this.authorized(req)) return this.send(res, 401, { error: "unauthorized" });

      if (method === "GET" && path === "/health") return this.send(res, 200, { ok: true });

      if (method === "GET" && path === "/status") return this.send(res, 200, this.deps.status());

      if (method === "GET" && path === "/workflows") {
        return this.send(res, 200, this.deps.listWorkflows());
      }
      if (method === "GET" && path === "/runs") {
        return this.send(res, 200, this.deps.listRuns(parseRunFilter(url)));
      }
      if (method === "GET" && path === "/runs/count") {
        const f = parseRunFilter(url);
        return this.send(res, 200, { total: this.deps.countRuns(f) });
      }
      // Live updates use the append-only event log and Last-Event-ID cursors.
      if (method === "GET" && path === "/stream") {
        return this.handleStream(req, res, url);
      }
      if (path.startsWith("/runs/")) {
        const rest = decodeURIComponent(path.slice("/runs/".length));
        const [id, sub, ...subPath] = rest.split("/");
        if (!id) return this.send(res, 404, { error: "not found" });

        if (method === "GET" && !sub) {
          const detail = this.deps.getRun(id);
          return detail ? this.send(res, 200, detail) : this.send(res, 404, { error: "not found" });
        }
        if (method === "GET" && sub === "events") {
          const after = Number(url.searchParams.get("after") ?? "0");
          const limit = Number(url.searchParams.get("limit") ?? "1000");
          return this.send(res, 200, this.deps.listRunEvents({ runId: id, after, limit }));
        }
        if (method === "POST" && sub === "cancel") {
          const cancelled = this.deps.cancel(id);
          return this.send(res, cancelled ? 200 : 409, {
            cancelled,
            ...(cancelled ? {} : { error: "run is not executing" }),
          });
        }
        if (method === "GET" && sub === "artifacts" && subPath.length === 0) {
          return this.send(res, 200, this.deps.listArtifacts(id));
        }
        if (method === "GET" && sub === "artifacts") {
          const file = this.deps.artifactFile(id, subPath.join("/"));
          if (!file) return this.send(res, 404, { error: "artifact not found" });
          return this.sendFile(res, file);
        }
        return this.send(res, 404, { error: "not found", path });
      }
      if (method === "GET" && path === "/approvals") {
        return this.send(res, 200, this.deps.listApprovals());
      }
      if (method === "POST" && path.startsWith("/approvals/") && path.endsWith("/respond")) {
        const id = decodeURIComponent(path.slice("/approvals/".length, -"/respond".length));
        const body = await this.readBody(req);
        const parsed = (body ? JSON.parse(body) : {}) as {
          text?: string;
          user?: string;
          scopeId?: string;
          requestId?: string;
        };
        if (!id || !parsed.text?.trim()) {
          return this.send(res, 400, { error: "body must include a non-empty \"text\"" });
        }
        const result = this.deps.respondApproval(
          id,
          parsed.text,
          parsed.user,
          parsed.scopeId,
          parsed.requestId,
        );
        return this.send(res, result.ok ? 200 : (result.status ?? 400), result);
      }
      if (method === "POST" && path.startsWith("/run/")) {
        const name = decodeURIComponent(path.slice("/run/".length));
        const body = await this.readBody(req);
        const input = body ? JSON.parse(body) : undefined;
        // Allow ?project=<root> so duplicate workflow names resolve to the
        // intended scope (project override) when a daemon is running.
        const projectRoot = url.searchParams.get("project") ?? undefined;
        const result = await this.deps.fire(name, input, projectRoot);
        return this.send(res, 200, result);
      }
      if (method === "POST" && path.startsWith("/replay/")) {
        const runId = decodeURIComponent(path.slice("/replay/".length));
        const result = await this.deps.replay(runId);
        return this.send(res, 200, result);
      }

      // Browser UI: the prebuilt SPA when shipped, inline page otherwise.
      if (this.opts.ui !== false && method === "GET" && this.serveUi(res, path)) return;

      this.send(res, 404, { error: "not found", path });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        return this.send(res, 413, { error: err.message, limit: err.limit });
      }
      if (err instanceof SyntaxError) return this.send(res, 400, { error: "invalid JSON body" });
      this.opts.logger.error(`control API error: ${String(err)}`);
      this.send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Serve the browser UI. Returns true when the request was handled: "/" (and
   * "/ui") always resolve to a page; asset paths resolve only when the file
   * exists inside uiDir. API 404s stay JSON because this runs after routing.
   */
  private serveUi(res: ServerResponse, path: string): boolean {
    const isRoot = path === "/" || path === "/ui";
    const dir = this.opts.uiDir;
    if (dir && existsSync(dir)) {
      const rel = isRoot ? "index.html" : path.replace(/^\/+/, "");
      const file = resolve(dir, rel);
      // Path traversal guard: the resolved file must stay inside uiDir.
      if (file === resolve(dir) || !file.startsWith(resolve(dir) + sep)) return false;
      if (existsSync(file) && statSync(file).isFile()) {
        this.sendFile(res, file);
        return true;
      }
      if (isRoot) {
        // uiDir exists but has no index.html — fall through to the inline page.
      } else {
        return false;
      }
    }
    if (!isRoot) return false;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(UI_HTML);
    return true;
  }

  private sendFile(res: ServerResponse, file: string): void {
    const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    const stream = createReadStream(file);
    stream.on("error", () => {
      // Headers are already sent; all we can do is drop the connection.
      res.destroy();
    });
    stream.pipe(res);
  }

  /** SSE: append-only run events with sequence cursors and Last-Event-ID resume. */
  private handleStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    this.streams.add(res);

    const headerCursor = req.headers["last-event-id"];
    const requestedCursor = url.searchParams.get("after");
    let cursor =
      headerCursor !== undefined
        ? Number(headerCursor)
        : requestedCursor === "latest"
          ? this.deps.latestRunEventSeq()
          : Number(requestedCursor ?? "0");
    if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;

    const push = (event: RunEventRecord) => {
      if (event.seq <= cursor) return;
      try {
        cursor = event.seq;
        res.write(`id: ${event.seq}\nevent: run-event\ndata: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        this.opts.logger.error(`stream push failed: ${String(err)}`);
      }
    };

    // Subscribe before catch-up so an event committed during the query cannot
    // fall between the backlog and live stream. Sequence de-dup handles overlap.
    const unsubscribe = this.deps.subscribeRunEvents(push);
    for (;;) {
      const batch = this.deps.listRunEvents({ after: cursor, limit: 1000 });
      for (const event of batch) push(event);
      if (batch.length < 1000) break;
    }
    const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      this.streams.delete(res);
    });
  }

  private async handleWebhook(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const handlers = this.webhooks.get(path);
    if (!handlers || handlers.size === 0) {
      return this.send(res, 404, { error: "no webhook registered", path });
    }
    const rawBody = await this.readBody(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : (v ?? "");
    }
    const url = new URL(req.url ?? "/", this.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    const whReq: WebhookRequest = { method: req.method ?? "POST", headers, rawBody, query };

    // Fan out to every workflow listening on this connector path. Each handler
    // verifies the signature and emits only if the event matches its filter.
    const results = await Promise.all([...handlers.values()].map((h) => h(whReq)));
    const accepted = results.some((r) => r.status >= 200 && r.status < 300);
    if (accepted) return this.send(res, 200, "ok");
    // None accepted — surface the first failure (e.g. 401 invalid signature).
    const first = results[0];
    this.send(res, first?.status ?? 400, first?.body ?? "rejected");
  }
}
