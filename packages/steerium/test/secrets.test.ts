import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redact, registerSecret } from "../src/logger.js";
import { resolveSecret, resolveSecretOrEnv } from "../src/secrets.js";
import { withEnv } from "./helpers.js";

test("resolveSecret handles literals, env refs, and absence", async () => {
  assert.equal(resolveSecret("literal-value"), "literal-value");
  assert.equal(resolveSecret(undefined), undefined);

  await withEnv({ STEERIUM_TEST_KEY: "from-env" }, async () => {
    assert.equal(resolveSecret({ env: "STEERIUM_TEST_KEY" }), "from-env");
  });
  // An env ref pointing at an unset variable is undefined, not the literal name.
  await withEnv({ STEERIUM_TEST_KEY: undefined }, async () => {
    assert.equal(resolveSecret({ env: "STEERIUM_TEST_KEY" }), undefined);
  });
});

test("resolveSecretOrEnv prefers the explicit secret over the fallback env var", async () => {
  await withEnv({ FALLBACK_VAR: "fallback" }, async () => {
    assert.equal(resolveSecretOrEnv("explicit", "FALLBACK_VAR"), "explicit");
    assert.equal(resolveSecretOrEnv(undefined, "FALLBACK_VAR"), "fallback");
  });
  await withEnv({ FALLBACK_VAR: undefined }, async () => {
    assert.equal(resolveSecretOrEnv(undefined, "FALLBACK_VAR"), undefined);
  });
});

test("an env ref that resolves empty falls through to the fallback var", async () => {
  // "" is falsy, so the explicit-wins branch must not claim it — otherwise a
  // blank export would silently shadow a working env var.
  await withEnv({ EMPTY_REF: "", FALLBACK_VAR: "fallback" }, async () => {
    assert.equal(resolveSecretOrEnv({ env: "EMPTY_REF" }, "FALLBACK_VAR"), "fallback");
  });
});

test("resolving a secret registers it for redaction in later log lines", async () => {
  await withEnv({ STEERIUM_TEST_TOKEN: "hunter2-very-secret" }, async () => {
    // Before resolution the value is just a string the logger knows nothing about.
    resolveSecret({ env: "STEERIUM_TEST_TOKEN" });
    const line = redact("calling api with token=hunter2-very-secret");
    assert.equal(line, "calling api with token=«redacted»");
    assert.ok(!line.includes("hunter2"), "the raw secret must not survive redaction");
  });
});

test("short values are not registered — redacting them would corrupt every line", () => {
  registerSecret("abc"); // under the 6-char floor
  assert.equal(
    redact("abc is a common substring in abcdef"),
    "abc is a common substring in abcdef",
  );
});

test("redact masks known key shapes it has never been told about", () => {
  // Pattern-based fallback: keeps a short prefix so a log is still debuggable.
  const masked = redact("Authorization: Bearer sk-abcdefghijklmnop");
  assert.match(masked, /sk-abc…«redacted»/);
  assert.ok(!masked.includes("defghijklmnop"));

  assert.match(redact("lin_api_0123456789abcdef"), /lin_ap…«redacted»/);
  assert.match(redact("ghp_0123456789abcdef"), /ghp_01…«redacted»/);
  assert.match(redact("xoxb-0123456789-abcdef"), /xoxb-0…«redacted»/);
});

test("redact leaves ordinary text alone", () => {
  const plain = "run ok in 42ms — wrote artifacts/out.txt";
  assert.equal(redact(plain), plain);
});
