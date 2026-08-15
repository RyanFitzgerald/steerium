/**
 * The UI's control-API client. Same runner as the steerium package (node:test +
 * tsx, no browser, no framework) — api.ts is plain TypeScript over fetch and
 * EventSource, so both are stubbed rather than emulated.
 *
 * The .tsx components are not covered here; that would mean a DOM and a second
 * test stack. What is covered is everything the components depend on being
 * right: URL construction, error surfacing, and the formatters.
 */
import { strict as assert } from "node:assert";
import { afterEach, test } from "node:test";
import { api, formatDuration, formatSize, formatTokens, subscribe } from "../src/api.js";

// ---- fetch stub ------------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const originalFetch = globalThis.fetch;
let calls: Call[] = [];

/** Install a fetch stub that answers every request with `respond`. */
function stubFetch(respond: (call: Call) => Response = () => jsonResponse({})): Call[] {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: typeof input === "string" ? input : String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---- query strings ----------------------------------------------------------------

test("query params are omitted when undefined or empty, so filters clear cleanly", async () => {
  const seen = stubFetch(() => jsonResponse([]));
  await api.runs({});
  assert.equal(seen[0]!.url, "/runs", "an empty query must not leave a dangling ?");

  await api.runs({ limit: 25, offset: 0, workflow: "", status: undefined });
  // offset: 0 is a real value and must survive; "" and undefined must not.
  assert.equal(seen[1]!.url, "/runs?limit=25&offset=0");

  await api.runs({ workflow: "deploy", status: "failed" });
  assert.equal(seen[2]!.url, "/runs?workflow=deploy&status=failed");
});

test("query values are URL-encoded", async () => {
  const seen = stubFetch(() => jsonResponse([]));
  await api.runs({ workflow: "a b&c=d" });
  assert.equal(seen[0]!.url, "/runs?workflow=a+b%26c%3Dd");
});

// ---- endpoints ----------------------------------------------------------------------

test("each endpoint hits the path the daemon serves", async () => {
  const seen = stubFetch(() => jsonResponse({}));
  await api.status();
  await api.workflows();
  await api.runsCount({ workflow: "w" });
  await api.run("run-1");
  await api.runEvents("run-1", 4);
  await api.artifacts("run-1");
  await api.approvals();
  await api.respondApproval("approval-1", "approve", "request-1", "global");
  assert.deepEqual(
    seen.map((c) => `${c.method} ${c.url}`),
    [
      "GET /status",
      "GET /workflows",
      "GET /runs/count?workflow=w",
      "GET /runs/run-1",
      "GET /runs/run-1/events?after=4",
      "GET /runs/run-1/artifacts",
      "GET /approvals",
      "POST /approvals/approval-1/respond",
    ],
  );
});

test("run ids are encoded, so an odd id cannot forge a path", async () => {
  const seen = stubFetch(() => jsonResponse({}));
  await api.run("a/b?c");
  assert.equal(seen[0]!.url, "/runs/a%2Fb%3Fc");
  await api.cancel("a/b");
  assert.equal(seen[1]!.url, "/runs/a%2Fb/cancel");
  await api.replay("a/b");
  assert.equal(seen[2]!.url, "/replay/a%2Fb");
});

test("fire posts JSON, defaulting to an empty object when no input is given", async () => {
  const seen = stubFetch(() => jsonResponse({ runId: "r", status: "ok" }));
  await api.fire("deploy");
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.url, "/run/deploy");
  assert.equal(seen[0]!.body, "{}");
  assert.equal(seen[0]!.headers["content-type"], "application/json");

  await api.fire("de ploy", { url: "https://x.com" });
  assert.equal(seen[1]!.url, "/run/de%20ploy");
  assert.deepEqual(JSON.parse(seen[1]!.body!), { url: "https://x.com" });
});

test("GET requests carry no content-type header", async () => {
  const seen = stubFetch(() => jsonResponse([]));
  await api.workflows();
  assert.deepEqual(seen[0]!.headers, {});
  assert.equal(seen[0]!.body, undefined);
});

test("artifactUrl encodes each segment but keeps the path separators", () => {
  assert.equal(
    api.artifactUrl("run 1", "out/my note.txt"),
    "/runs/run%201/artifacts/out/my%20note.txt",
  );
  assert.equal(api.artifactUrl("r", "a.txt"), "/runs/r/artifacts/a.txt");
});

// ---- errors ---------------------------------------------------------------------------

test("a JSON error body surfaces the daemon's message, not the bare status", async () => {
  stubFetch(() => jsonResponse({ error: "workflow not found" }, 404));
  await assert.rejects(api.run("nope"), /workflow not found/);
});

test("a non-JSON error body falls back to the status code", async () => {
  stubFetch(() => new Response("<html>502</html>", { status: 502 }));
  await assert.rejects(api.run("x"), /^Error: 502$/);
});

test("an error body without an error field falls back to the status code", async () => {
  stubFetch(() => jsonResponse({ detail: "something" }, 500));
  await assert.rejects(api.run("x"), /^Error: 500$/);
});

// ---- SSE ----------------------------------------------------------------------------

class FakeEventSource {
  static last: FakeEventSource | undefined;
  listeners = new Map<string, (ev: unknown) => void>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

function withFakeEventSource<T>(fn: () => T): T {
  const original = (globalThis as { EventSource?: unknown }).EventSource;
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  try {
    return fn();
  } finally {
    (globalThis as { EventSource?: unknown }).EventSource = original;
  }
}

test("subscribe follows run events, refreshes projections, and closes", async () => {
  stubFetch((call) => {
    if (call.url === "/runs/r1") {
      return jsonResponse({ run: { id: "r1" }, steps: [], agentCalls: [], events: [] });
    }
    return jsonResponse([{ id: "r1" }]);
  });
  let unsubscribe = () => {};
  const updates: unknown[] = [];
  const states: boolean[] = [];
  withFakeEventSource(() => {
    unsubscribe = subscribe(
      { workflow: "deploy", run: "r1" },
      (d) => updates.push(d),
      (c) => states.push(c),
    );
  });
  const es = FakeEventSource.last!;
  assert.equal(es.url, "/stream?after=latest");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(updates, [{
    runs: [{ id: "r1" }],
    detail: { run: { id: "r1" }, steps: [], agentCalls: [], events: [] },
  }]);

  es.emit("run-event", { seq: 2, run_id: "r1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(updates.length, 2);
  assert.deepEqual(states, [true], "a run event implies the stream is connected");
  es.onerror!();
  es.onopen!();
  assert.deepEqual(states, [true, false, true]);
  unsubscribe();
  assert.equal(es.closed, true);
});

test("subscribe works without an onStateChange callback", async () => {
  stubFetch(() => jsonResponse([]));
  const updates: unknown[] = [];
  withFakeEventSource(() => {
    subscribe({}, (d) => updates.push(d));
    const es = FakeEventSource.last!;
    assert.equal(es.url, "/stream?after=latest");
    es.onerror!(); // must not throw with no callback registered
    es.emit("run-event", { seq: 1 });
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(updates.length >= 1);
});

// ---- formatters --------------------------------------------------------------------

test("formatDuration scales from ms to minutes and blanks an unstarted run", () => {
  // A queued run has started_at = null and should render as blank, not "0ms".
  assert.equal(formatDuration(null, null), "");
  assert.equal(formatDuration(null, 5000), "");

  const t0 = 1_700_000_000_000;
  assert.equal(formatDuration(t0, t0 + 420), "420ms");
  assert.equal(formatDuration(t0, t0 + 999), "999ms");
  assert.equal(formatDuration(t0, t0 + 1000), "1.0s");
  assert.equal(formatDuration(t0, t0 + 5500), "5.5s");
  assert.equal(formatDuration(t0, t0 + 59_999), "60.0s");
  assert.equal(formatDuration(t0, t0 + 60_000), "1m 0s");
  assert.equal(formatDuration(t0, t0 + 95_000), "1m 35s");
  assert.equal(formatDuration(t0, t0 + 3_600_000), "60m 0s");
});

test("formatDuration measures a still-running step against now", () => {
  const elapsed = formatDuration(Date.now() - 1500, null);
  assert.match(elapsed, /^1\.[45]s$/, `expected ~1.5s, got ${elapsed}`);
});

test("formatTokens matches the CLI's abbreviations", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1234), "1.2k");
  assert.equal(formatTokens(10_000), "10k");
  assert.equal(formatTokens(1_000_000), "1.0M");
  assert.equal(formatTokens(12_345_678), "12M");
});

test("formatSize switches units at each 1024 boundary", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(1023), "1023 B");
  assert.equal(formatSize(1024), "1.0 KB");
  assert.equal(formatSize(1536), "1.5 KB");
  assert.equal(formatSize(1024 * 1024), "1.0 MB");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
});
