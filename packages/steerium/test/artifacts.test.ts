import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import { createArtifactWriter } from "../src/runtime/artifacts.js";
import { tempDir } from "./helpers.js";

test("writeText, writeJSON and writeBytes land in the run dir and return the path", async () => {
  const dir = tempDir("steerium-art-");
  const art = createArtifactWriter(dir);
  assert.equal(art.dir, dir);

  const textPath = await art.writeText("note.txt", "hello artifacts");
  assert.equal(textPath, join(dir, "note.txt"));
  assert.equal(readFileSync(textPath, "utf8"), "hello artifacts");

  const jsonPath = await art.writeJSON("data.json", { a: 1, b: [2, 3] });
  // Pretty-printed: these files are meant to be read by a human in the UI.
  assert.equal(readFileSync(jsonPath, "utf8"), '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');

  const bytesPath = await art.writeBytes("raw.bin", new Uint8Array([0, 1, 254, 255]));
  assert.deepEqual([...readFileSync(bytesPath)], [0, 1, 254, 255]);
});

test("subdirectories are created on demand", async () => {
  const dir = tempDir("steerium-art-");
  const art = createArtifactWriter(dir);
  const path = await art.writeText("out/deep/nested.txt", "ok");
  assert.equal(path, join(dir, "out", "deep", "nested.txt"));
  assert.equal(readFileSync(path, "utf8"), "ok");
});

test("names that escape the run directory are refused", async () => {
  const dir = tempDir("steerium-art-");
  const art = createArtifactWriter(dir);

  for (const name of ["../escape.txt", "out/../../escape.txt", `..${sep}..${sep}etc${sep}passwd`]) {
    await assert.rejects(art.writeText(name, "x"), /escapes the run directory/, name);
  }
  // Absolute paths resolve away from the root too, so they must be refused.
  await assert.rejects(art.writeText("/tmp/absolute.txt", "x"), /escapes the run directory/);
  // All three writers share the guard, not just writeText.
  await assert.rejects(art.writeJSON("../escape.json", {}), /escapes the run directory/);
  await assert.rejects(
    art.writeBytes("../escape.bin", new Uint8Array()),
    /escapes the run directory/,
  );
});

test("a name that merely starts with the root's characters does not slip through", async () => {
  // Guards written as `path.startsWith(root)` (no separator) let a sibling
  // directory named "<root>-evil" pass. This one checks root + sep.
  const parent = tempDir("steerium-art-");
  const root = join(parent, "run");
  const art = createArtifactWriter(root);
  await assert.rejects(art.writeText("../run-evil/x.txt", "x"), /escapes the run directory/);
});

test("writing the run directory itself is refused", async () => {
  const dir = tempDir("steerium-art-");
  const art = createArtifactWriter(dir);
  // "." resolves to the root exactly — inside is required, not equal to.
  await assert.rejects(art.writeText(".", "x"), /escapes the run directory/);
});

test("re-writing the same name overwrites rather than appending", async () => {
  const dir = tempDir("steerium-art-");
  const art = createArtifactWriter(dir);
  await art.writeText("same.txt", "first");
  const path = await art.writeText("same.txt", "second");
  assert.equal(readFileSync(path, "utf8"), "second");
});
