import { strict as assert } from "node:assert";
import { test } from "node:test";
import { defineConfig, defineWorkflow } from "../src/define.js";
import { normalizeConfig, normalizeWorkflowDefinition } from "../src/config/normalize.js";
import { manual } from "../src/triggers/manual.js";
import { configFingerprint } from "../src/runtime/provenance.js";

test("define helpers stay pass-through while load normalization is strict", () => {
  const config = { defaults: { concurrency: 2 } };
  assert.equal(defineConfig(config), config);
  const workflow = { name: "ok", on: manual(), async run() {} };
  assert.equal(defineWorkflow(workflow), workflow);
  assert.equal(normalizeConfig(config, "config.ts"), config);
  assert.equal(normalizeWorkflowDefinition(workflow, "ok.ts"), workflow);
});

test("config fingerprints include behavior settings but never secret values", () => {
  const a = configFingerprint({
    providers: { openai: { model: "m1", apiKey: "secret-a" } },
    connectors: { github: { token: "token-a", repo: "owner/repo" } },
  });
  const b = configFingerprint({
    providers: { openai: { model: "m1", apiKey: "secret-b" } },
    connectors: { github: { token: "token-b", repo: "owner/repo" } },
  });
  const changed = configFingerprint({
    providers: { openai: { model: "m2", apiKey: "secret-a" } },
    connectors: { github: { token: "token-a", repo: "owner/repo" } },
  });
  assert.equal(a, b);
  assert.notEqual(a, changed);
});

test("normalizers reject unknown fields, invalid bounds, and malformed triggers", () => {
  assert.throws(
    () => normalizeConfig({ contrl: {} }, "config.ts"),
    /unknown field.*contrl/,
  );
  assert.throws(
    () => normalizeConfig({ defaults: { concurrency: 0 } }, "config.ts"),
    /concurrency must be a finite number >= 1/,
  );
  assert.throws(
    () =>
      normalizeWorkflowDefinition(
        { name: "bad", on: manual(), run() {}, timeoutMs: -1 },
        "bad.ts",
      ),
    /timeoutMs must be a finite number >= 1/,
  );
  assert.throws(
    () => normalizeWorkflowDefinition({ name: "bad", on: {}, run() {} }, "bad.ts"),
    /must be a Trigger/,
  );
});
