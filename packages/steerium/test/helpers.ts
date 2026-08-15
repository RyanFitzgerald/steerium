/**
 * Shared test scaffolding.
 *
 * Every helper that touches the filesystem allocates under the OS temp dir and
 * registers the path for removal at process exit, so a test run leaves nothing
 * behind. `freshHome()` mutates `process.env.STEERIUM_HOME`, which is why
 * node:test's default of one process per file (and sequential tests within a
 * file) matters — see the note on ISOLATION below.
 *
 * ISOLATION: tests in a file that calls freshHome() share one env var and must
 * not run concurrently. Do not add `concurrency: true` to those files without
 * first making the home a per-test value threaded explicitly.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, type DaemonOptions } from "../src/runtime/daemon.js";
import { globalScope } from "../src/scope.js";
import type {
  KeyValueState,
  Logger,
  ProviderContext,
  TriggerContext,
  WebhookHandler,
  WebhookRequest,
} from "../src/types.js";

// ---- temp filesystem ----------------------------------------------------------

const tempDirs: string[] = [];
let cleanupRegistered = false;

/** An empty temp directory, removed when the test process exits. */
export function tempDir(prefix = "steerium-test-"): string {
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on("exit", () => {
      for (const dir of tempDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort; a leaked temp dir must never fail a test run */
        }
      }
    });
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export interface FreshHomeOptions {
  /** Full source for the home's config.ts. Omit to leave the home config-less. */
  config?: string;
}

/**
 * Build an isolated STEERIUM_HOME, point the env var at it, and return its path.
 * The workflows/ dir always exists so callers can drop files straight in.
 */
export function freshHome(opts: FreshHomeOptions = {}): string {
  const home = tempDir();
  process.env.STEERIUM_HOME = home;
  mkdirSync(join(home, "workflows"), { recursive: true });
  if (opts.config !== undefined) writeFileSync(join(home, "config.ts"), opts.config, "utf8");
  return home;
}

/** Write a workflow file into a home's workflows/ dir. Returns its path. */
export function writeWorkflow(home: string, name: string, source: string): string {
  const path = join(home, "workflows", `${name}.ts`);
  writeFileSync(path, source, "utf8");
  return path;
}

/** A temp directory scaffolded as a steerium project (.steerium/workflows/). */
export function freshProject(opts: { config?: string } = {}): string {
  const root = tempDir("steerium-proj-");
  mkdirSync(join(root, ".steerium", "workflows"), { recursive: true });
  if (opts.config !== undefined) {
    writeFileSync(join(root, ".steerium", "config.ts"), opts.config, "utf8");
  }
  return root;
}

/** Write a workflow into a project's .steerium/workflows/ dir. */
export function writeProjectWorkflow(root: string, name: string, source: string): string {
  const path = join(root, ".steerium", "workflows", `${name}.ts`);
  writeFileSync(path, source, "utf8");
  return path;
}

// ---- daemon -------------------------------------------------------------------

/**
 * An initialized daemon with triggers disabled. Call after freshHome() — the
 * daemon resolves STEERIUM_HOME in its constructor.
 */
export async function newDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const d = new Daemon({ triggersDisabled: true, ...opts });
  await d.init();
  return d;
}

/** As newDaemon(), but also starts the control server. */
export async function startedDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const d = await newDaemon(opts);
  await d.start(); // with triggersDisabled, only the control server comes up
  return d;
}

/**
 * An OS-assigned free TCP port. Racier than binding port 0 and keeping it, but
 * the daemon's control config takes a number, and a fresh port per test beats
 * a fixed one that collides with a developer's running daemon.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** A home whose config binds the control server to a free port. */
export async function freshHomeWithControl(extra = ""): Promise<{ home: string; port: number }> {
  const port = await freePort();
  const home = freshHome({
    config: `import { defineConfig } from "steerium";
     export default defineConfig({ control: { port: ${port} }${extra ? `, ${extra}` : ""} });`,
  });
  return { home, port };
}

// ---- fakes --------------------------------------------------------------------

/** A logger that records lines instead of writing them. */
export function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const make = (prefix: string): Logger & { lines: string[] } => ({
    lines,
    debug: (m) => lines.push(`${prefix}debug ${m}`),
    info: (m) => lines.push(`${prefix}info ${m}`),
    warn: (m) => lines.push(`${prefix}warn ${m}`),
    error: (m) => lines.push(`${prefix}error ${m}`),
    child: (b) => make(`${prefix}${Object.values(b).join(" ")} `),
  });
  return make("");
}

/** An in-memory KeyValueState. */
export function memState(): KeyValueState {
  const m = new Map<string, unknown>();
  return {
    async get(k) {
      return m.get(k) as never;
    },
    async set(k, v) {
      m.set(k, v);
    },
    async delete(k) {
      m.delete(k);
    },
    async list() {
      return [...m.entries()].map(([key, value]) => ({
        key,
        value: value as never,
      }));
    },
  };
}

export interface FakeTriggerCtx {
  ctx: TriggerContext;
  /** The handler passed to registerWebhook, once a trigger has registered one. */
  getHandler(): WebhookHandler | undefined;
  /** The path passed to registerWebhook. */
  getPath(): string | undefined;
  logger: Logger & { lines: string[] };
}

/** A TriggerContext stub that captures any registered webhook handler. */
export function fakeTriggerCtx(connectorConfig: Record<string, unknown> = {}): FakeTriggerCtx {
  let handler: WebhookHandler | undefined;
  let path: string | undefined;
  const logger = recordingLogger();
  const ctx: TriggerContext = {
    scope: globalScope("/tmp"),
    logger,
    state: memState(),
    kv: () => memState(),
    connector: <T>(name: string) => (connectorConfig[name] ?? connectorConfig) as T,
    registerWebhook: (p, h) => {
      path = p;
      handler = h;
    },
  };
  return { ctx, getHandler: () => handler, getPath: () => path, logger };
}

/** A ProviderContext stub whose logger records instead of printing. */
export function fakeProviderCtx(
  config: ProviderContext["config"] = {},
  extra: Omit<Partial<ProviderContext>, "logger"> = {},
): ProviderContext & { logger: Logger & { lines: string[] } } {
  const logger = recordingLogger();
  return { scope: globalScope("/tmp"), config, ...extra, logger };
}

/** Build a WebhookRequest, defaulting the boring fields. */
export function webhookRequest(
  partial: Partial<WebhookRequest> & { rawBody: string },
): WebhookRequest {
  return {
    method: "POST",
    headers: {},
    query: {},
    ...partial,
  };
}

// ---- http ---------------------------------------------------------------------

export interface StubServer {
  url: string;
  /** Every request the server received, in order. */
  requests: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: string;
  }>;
  close(): Promise<void>;
}

/**
 * A localhost HTTP server that answers every request with `respond`. Used to
 * point real SDK clients (which honor *_BASE_URL) at a fake API, so provider
 * transport is exercised end to end without a network.
 */
export async function stubServer(
  respond: (req: {
    method: string;
    path: string;
    body: string;
  }) =>
    | { status?: number; json?: unknown; text?: string }
    | Promise<{ status?: number; json?: unknown; text?: string }>,
): Promise<StubServer> {
  const requests: StubServer["requests"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const entry = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers as Record<string, string>,
          body,
        };
        requests.push(entry);
        try {
          const out = await respond({
            method: entry.method,
            path: entry.path,
            body,
          });
          const payload = out.text ?? JSON.stringify(out.json ?? {});
          res.writeHead(out.status ?? 200, {
            "content-type": "application/json",
          });
          res.end(payload);
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Swap globalThis.fetch for the duration of `fn`, recording calls. Restores the
 * original even when fn throws.
 */
export async function withFetch<T>(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  fn: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** A JSON Response, for withFetch handlers. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---- misc ---------------------------------------------------------------------

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll `check` until it returns a truthy value or the deadline passes. Beats a
 * fixed sleep: fast when the condition lands early, and it fails loudly instead
 * of leaving a flaky assertion behind.
 */
export async function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  { timeoutMs = 5000, intervalMs = 10, message = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${message}`);
    await delay(intervalMs);
  }
}

/** Set env vars for the duration of `fn`, restoring prior values after. */
export async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
