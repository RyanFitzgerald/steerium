/**
 * Provider transport and registry.
 *
 * usage.ts (the pure response→AgentUsage mappers) is covered in
 * agent-calls.test.ts. What is exercised here is everything around it: the
 * HTTP path each SDK-backed provider actually takes, credential resolution,
 * health probes, and the registry that dispatches to them.
 *
 * The HTTP providers are pointed at a localhost stub via the SDKs' own
 * *_BASE_URL env vars, so the real client code runs — request shaping,
 * response parsing, usage mapping — with no network and no module mocking.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { mockProvider } from "../src/providers/mock.js";
import { openaiProvider } from "../src/providers/openai.js";
import { ProviderRegistry, type SettledAgentCall } from "../src/providers/registry.js";
import { runCli } from "../src/providers/subprocess.js";
import { AgentCallError } from "../src/providers/usage.js";
import { globalScope } from "../src/scope.js";
import type { Provider } from "../src/types.js";
import { fakeProviderCtx, stubServer, withEnv } from "./helpers.js";

// ---- anthropic ----------------------------------------------------------------

const ANTHROPIC_OK = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [
    { type: "text", text: "hello " },
    { type: "thinking", thinking: "…" }, // non-text blocks are skipped
    { type: "text", text: "world" },
  ],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 11,
    output_tokens: 22,
    cache_read_input_tokens: 33,
    cache_creation_input_tokens: 44,
  },
};

test("anthropic: posts to the Messages API and maps the response end to end", async () => {
  const server = await stubServer(() => ({ json: ANTHROPIC_OK }));
  try {
    const res = await withEnv(
      {
        ANTHROPIC_BASE_URL: server.url,
        ANTHROPIC_API_KEY: "sk-test-key-value",
      },
      () =>
        anthropicProvider.run(
          {
            prompt: "say hi",
            system: "be brief",
            maxTokens: 100,
            model: "claude-opus-5",
          },
          fakeProviderCtx(),
        ),
    );

    // Only text blocks are concatenated.
    assert.equal(res.text, "hello world");
    assert.deepEqual(res.usage, {
      inputTokens: 11,
      outputTokens: 22,
      cacheReadTokens: 33,
      cacheCreationTokens: 44,
      model: "claude-opus-5",
    });

    const req = server.requests[0]!;
    assert.equal(req.method, "POST");
    assert.match(req.path, /\/v1\/messages$/);
    assert.equal(req.headers["x-api-key"], "sk-test-key-value");
    const body = JSON.parse(req.body) as Record<string, unknown>;
    assert.equal(body["model"], "claude-opus-5");
    assert.equal(body["max_tokens"], 100);
    assert.equal(body["system"], "be brief");
    assert.deepEqual(body["messages"], [{ role: "user", content: "say hi" }]);
  } finally {
    await server.close();
  }
});

test("anthropic: defaults model and max_tokens, and omits system when unset", async () => {
  const server = await stubServer(() => ({ json: ANTHROPIC_OK }));
  try {
    await withEnv({ ANTHROPIC_BASE_URL: server.url, ANTHROPIC_API_KEY: "k" }, () =>
      anthropicProvider.run({ prompt: "hi" }, fakeProviderCtx()),
    );
    const body = JSON.parse(server.requests[0]!.body) as Record<string, unknown>;
    assert.equal(body["max_tokens"], 4096);
    assert.ok(typeof body["model"] === "string" && body["model"]!.length > 0);
    assert.ok(!("system" in body), "an unset system prompt must not be sent as undefined/null");
  } finally {
    await server.close();
  }
});

test("anthropic: provider config supplies the model and the key when env is unset", async () => {
  const server = await stubServer(() => ({ json: ANTHROPIC_OK }));
  try {
    await withEnv({ ANTHROPIC_BASE_URL: server.url, ANTHROPIC_API_KEY: undefined }, () =>
      anthropicProvider.run(
        { prompt: "hi" },
        fakeProviderCtx({
          apiKey: "sk-from-config-value",
          model: "claude-sonnet-5",
        }),
      ),
    );
    const req = server.requests[0]!;
    assert.equal(req.headers["x-api-key"], "sk-from-config-value");
    assert.equal((JSON.parse(req.body) as { model: string }).model, "claude-sonnet-5");
  } finally {
    await server.close();
  }
});

test("anthropic: an explicit opts.model beats the provider config default", async () => {
  const server = await stubServer(() => ({ json: ANTHROPIC_OK }));
  try {
    await withEnv({ ANTHROPIC_BASE_URL: server.url, ANTHROPIC_API_KEY: "k" }, () =>
      anthropicProvider.run(
        { prompt: "hi", model: "claude-haiku-4-5-20251001" },
        fakeProviderCtx({ model: "claude-opus-5" }),
      ),
    );
    assert.equal(
      (JSON.parse(server.requests[0]!.body) as { model: string }).model,
      "claude-haiku-4-5-20251001",
    );
  } finally {
    await server.close();
  }
});

test("anthropic: with no key anywhere, the error names both ways to set one", async () => {
  await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
    await assert.rejects(
      anthropicProvider.run({ prompt: "hi" }, fakeProviderCtx()),
      /ANTHROPIC_API_KEY or providers\.anthropic\.apiKey/,
    );
  });
});

test("anthropic: health reports which credential resolved", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "sk-present" }, async () => {
    assert.deepEqual(await anthropicProvider.health!(fakeProviderCtx()), {
      ok: true,
      auth: "api-key",
      detail: "ANTHROPIC_API_KEY resolved",
    });
  });
  await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
    const h = await anthropicProvider.health!(fakeProviderCtx());
    assert.equal(h.ok, false);
    assert.equal(h.auth, "missing");
    // Config-supplied keys count even when the env var is absent.
    const withConfig = await anthropicProvider.health!(fakeProviderCtx({ apiKey: "sk-cfg" }));
    assert.equal(withConfig.ok, true);
  });
});

// ---- openai --------------------------------------------------------------------

const OPENAI_OK = {
  id: "resp_1",
  object: "response",
  model: "gpt-4o",
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hi there" }],
    },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    input_tokens_details: { cached_tokens: 60 },
  },
};

test("openai: posts to the Responses API and subtracts cached tokens from input", async () => {
  const server = await stubServer(() => ({ json: OPENAI_OK }));
  try {
    const res = await withEnv(
      { OPENAI_BASE_URL: server.url, OPENAI_API_KEY: "sk-openai-test" },
      () =>
        openaiProvider.run(
          { prompt: "say hi", system: "be brief", maxTokens: 50 },
          fakeProviderCtx(),
        ),
    );
    assert.equal(res.text, "hi there");
    // Disjoint fields: 100 reported input includes 60 cached, so input is 40.
    assert.equal(res.usage!.inputTokens, 40);
    assert.equal(res.usage!.cacheReadTokens, 60);
    assert.equal(res.usage!.outputTokens, 20);

    const req = server.requests[0]!;
    assert.equal(req.headers["authorization"], "Bearer sk-openai-test");
    const body = JSON.parse(req.body) as Record<string, unknown>;
    assert.equal(body["instructions"], "be brief");
    assert.equal(body["input"], "say hi");
    assert.equal(body["max_output_tokens"], 50);
    assert.equal(body["model"], "gpt-4o");
  } finally {
    await server.close();
  }
});

test("openai: outputSchema becomes a json_schema response format", async () => {
  const server = await stubServer(() => ({ json: OPENAI_OK }));
  try {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    await withEnv({ OPENAI_BASE_URL: server.url, OPENAI_API_KEY: "k" }, () =>
      openaiProvider.run({ prompt: "hi", outputSchema: schema }, fakeProviderCtx()),
    );
    const body = JSON.parse(server.requests[0]!.body) as {
      text: { format: { type: string; name: string; schema: unknown } };
    };
    assert.equal(body.text.format.type, "json_schema");
    assert.equal(body.text.format.name, "output");
    assert.deepEqual(body.text.format.schema, schema);
  } finally {
    await server.close();
  }
});

test("openai: max_output_tokens is omitted when maxTokens is unset", async () => {
  const server = await stubServer(() => ({ json: OPENAI_OK }));
  try {
    await withEnv({ OPENAI_BASE_URL: server.url, OPENAI_API_KEY: "k" }, () =>
      openaiProvider.run({ prompt: "hi" }, fakeProviderCtx()),
    );
    const body = JSON.parse(server.requests[0]!.body) as Record<string, unknown>;
    assert.ok(!("max_output_tokens" in body), "an unset cap must not be sent");
  } finally {
    await server.close();
  }
});

test("openai: with no key anywhere, the error names both ways to set one", async () => {
  await withEnv({ OPENAI_API_KEY: undefined }, async () => {
    await assert.rejects(
      openaiProvider.run({ prompt: "hi" }, fakeProviderCtx()),
      /OPENAI_API_KEY or providers\.openai\.apiKey/,
    );
  });
});

test("openai: health reports which credential resolved", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-present" }, async () => {
    const h = await openaiProvider.health!(fakeProviderCtx());
    assert.equal(h.ok, true);
    assert.equal(h.auth, "api-key");
  });
  await withEnv({ OPENAI_API_KEY: undefined }, async () => {
    const h = await openaiProvider.health!(fakeProviderCtx());
    assert.equal(h.ok, false);
    assert.equal(h.auth, "missing");
  });
});

// ---- mock ----------------------------------------------------------------------

test("mock: deterministic text and char-count usage, always healthy", async () => {
  const res = await mockProvider.run({ prompt: "hello", model: "m1" }, fakeProviderCtx());
  assert.equal(res.text, "[mock:m1] hello");
  assert.equal(res.usage!.inputTokens, 5);
  assert.equal(res.usage!.outputTokens, res.text.length);
  assert.equal(res.usage!.model, "m1");
  assert.equal((await mockProvider.health!(fakeProviderCtx())).ok, true);

  // Long prompts are truncated in the echo but counted in full.
  const long = "x".repeat(500);
  const big = await mockProvider.run({ prompt: long }, fakeProviderCtx());
  assert.equal(big.usage!.inputTokens, 500);
  assert.equal(big.text, `[mock:default] ${"x".repeat(280)}`);
});

// ---- registry ------------------------------------------------------------------

const scope = globalScope("/tmp");
const logger = fakeProviderCtx().logger;

test("registry: built-ins are registered and mock is the default", () => {
  const r = new ProviderRegistry({});
  assert.deepEqual(r.list().sort(), ["anthropic", "claude", "codex", "mock", "openai"]);
  assert.equal(r.defaultProvider, "mock");
  assert.equal(r.has("mock"), true);
  assert.equal(r.has("nope"), false);
});

test("registry: an unknown provider names what is registered", () => {
  const r = new ProviderRegistry({});
  assert.throws(() => r.get("nope"), /Unknown provider "nope"\. Registered: .*mock/);
});

test("registry: a config entry either configures a built-in or registers a new provider", async () => {
  const custom: Provider = {
    name: "custom",
    async run(opts) {
      return { text: `custom:${opts.prompt}` };
    },
  };
  const r = new ProviderRegistry({
    providers: { anthropic: { model: "claude-opus-5" }, custom },
    defaults: { provider: "custom" },
  });

  // A plain settings object configures the built-in; it does not replace it.
  assert.equal(r.get("anthropic").name, "anthropic");
  assert.deepEqual(r.configFor("anthropic"), { model: "claude-opus-5" });
  // An object with name+run is a provider implementation.
  assert.equal(r.get("custom").name, "custom");
  assert.deepEqual(r.configFor("custom"), {}, "an implementation carries no settings");
  assert.equal(r.defaultProvider, "custom");

  const agent = r.agentFor(scope, logger);
  assert.equal((await agent.run({ prompt: "x" })).text, "custom:x");
});

test("registry: a config provider can replace a built-in by name", async () => {
  const fake: Provider = {
    name: "mock",
    run: async () => ({ text: "replaced" }),
  };
  const r = new ProviderRegistry({ providers: { mock: fake } });
  assert.equal((await r.agentFor(scope, logger).run({ prompt: "x" })).text, "replaced");
});

test("registry: the observer sees provider, model, and usage for a successful call", async () => {
  const r = new ProviderRegistry({});
  const seen: SettledAgentCall[] = [];
  const agent = r.agentFor(scope, logger, undefined, (c) => seen.push(c));

  await agent.run({ prompt: "hello", model: "m1" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.provider, "mock");
  assert.equal(seen[0]!.status, "ok");
  assert.equal(seen[0]!.model, "m1");
  assert.equal(seen[0]!.usage!.inputTokens, 5);
  assert.equal(seen[0]!.error, null);
  assert.ok(seen[0]!.finishedAt >= seen[0]!.startedAt);
});

test("registry: a failing call is still reported, then rethrown", async () => {
  const boom: Provider = {
    name: "boom",
    async run() {
      throw new Error("kaput");
    },
  };
  const r = new ProviderRegistry({
    providers: { boom },
    defaults: { provider: "boom" },
  });
  const seen: SettledAgentCall[] = [];
  const agent = r.agentFor(scope, logger, undefined, (c) => seen.push(c));

  await assert.rejects(agent.run({ prompt: "x" }), /kaput/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.status, "failed");
  assert.equal(seen[0]!.error, "kaput");
  assert.equal(seen[0]!.usage, undefined, "unknown usage, not zeroed");
});

test("registry: structured output is opt-in and returned as typed data", async () => {
  let calls = 0;
  const unsupported: Provider = {
    name: "unsupported",
    async run() {
      calls++;
      return { text: "{}" };
    },
  };
  const unsupportedRegistry = new ProviderRegistry({ providers: { unsupported } });
  await assert.rejects(
    unsupportedRegistry.agentFor(scope, logger).run({
      provider: "unsupported",
      prompt: "x",
      outputSchema: { type: "object" },
    }),
    /does not declare supportsStructuredOutput/,
  );
  assert.equal(calls, 0, "unsupported providers fail before making a call");

  let receivedSchema: unknown;
  const structured: Provider = {
    name: "structured",
    supportsStructuredOutput: true,
    async run(opts) {
      receivedSchema = opts.outputSchema;
      return { text: JSON.stringify({ answer: 42 }) };
    },
  };
  const registry = new ProviderRegistry({ providers: { structured } });
  const schema = {
    "~standard": {
      version: 1 as const,
      jsonSchema: { output: () => ({ type: "object", required: ["answer"] }) },
      validate: (value: unknown) =>
        typeof (value as { answer?: unknown }).answer === "number"
          ? { value: value as { answer: number } }
          : { issues: [{ message: "answer must be a number" }] },
    },
  };
  const result = await registry.agentFor(scope, logger).run<{ answer: number }>({
    provider: "structured",
    prompt: "x",
    outputSchema: schema,
  });
  assert.deepEqual(receivedSchema, { type: "object", required: ["answer"] });
  assert.deepEqual(result.data, { answer: 42 });
});

test("registry: AgentCallError usage is matched by name, not instanceof", async () => {
  // A third-party provider package may bundle its own copy of the class, so a
  // structural/name check is what keeps its burned tokens from being dropped.
  class ForeignAgentCallError extends Error {
    usage = { inputTokens: 7, outputTokens: 3, model: "m" };
    constructor(msg: string) {
      super(msg);
      this.name = "AgentCallError";
    }
  }
  const burn: Provider = {
    name: "burn",
    async run() {
      throw new ForeignAgentCallError("aborted mid-run");
    },
  };
  const r = new ProviderRegistry({
    providers: { burn },
    defaults: { provider: "burn" },
  });
  const seen: SettledAgentCall[] = [];
  await assert.rejects(
    r.agentFor(scope, logger, undefined, (c) => seen.push(c)).run({ prompt: "x" }),
  );
  assert.equal(seen[0]!.usage!.inputTokens, 7);
  assert.equal(seen[0]!.model, "m");
  assert.ok(
    !(new ForeignAgentCallError("x") instanceof AgentCallError),
    "premise: not the same class",
  );
});

test("registry: an observer that throws never breaks the workflow", async () => {
  const r = new ProviderRegistry({});
  const agent = r.agentFor(scope, logger, undefined, () => {
    throw new Error("accounting exploded");
  });
  const res = await agent.run({ prompt: "hello" });
  assert.equal(res.text, "[mock:default] hello");
});

test("registry: the run's abort signal reaches the provider", async () => {
  const controller = new AbortController();
  const seenSignals: Array<AbortSignal | undefined> = [];
  const spy: Provider = {
    name: "spy",
    async run(_opts, ctx) {
      seenSignals.push(ctx.signal);
      return { text: "" };
    },
  };
  const r = new ProviderRegistry({
    providers: { spy },
    defaults: { provider: "spy" },
  });
  await r.agentFor(scope, logger, controller.signal).run({ prompt: "x" });
  assert.equal(seenSignals[0], controller.signal);
});

// ---- subprocess ----------------------------------------------------------------

test("runCli feeds stdin and captures stdout and stderr", async () => {
  const script =
    "let s='';process.stdin.on('data',c=>s+=c);" +
    "process.stdin.on('end',()=>{process.stdout.write('got:'+s);process.stderr.write('noise')})";
  const res = await runCli(process.execPath, ["-e", script], {
    input: "payload",
  });
  assert.equal(res.stdout, "got:payload");
  assert.equal(res.stderr, "noise");
});

test("runCli reports a missing binary as a PATH problem, not a raw ENOENT", async () => {
  await assert.rejects(
    runCli("steerium-no-such-binary-xyz", []),
    /CLI "steerium-no-such-binary-xyz" not found on PATH/,
  );
});

test("runCli surfaces a non-zero exit with the child's stderr", async () => {
  await assert.rejects(
    runCli(process.execPath, ["-e", "process.stderr.write('bad input');process.exit(3)"]),
    /bad input/,
  );
});

test("runCli maps an aborted run to a timeout message", async () => {
  const controller = new AbortController();
  const pending = runCli(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /aborted \(run timed out\)/);
});

test("runCli passes cwd through to the child", async () => {
  const { stdout } = await runCli(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
    cwd: "/",
  });
  assert.equal(stdout, "/");
});
