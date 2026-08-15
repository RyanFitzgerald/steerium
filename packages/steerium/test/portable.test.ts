import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { freshHome, tempDir } from "./helpers.js";

test("config export/import round-trips config, workflows, and projects", async () => {
  const home = freshHome();
  // Imported lazily so STEERIUM_HOME is already set.
  const { exportBundle, importBundle, parseBundle } = await import("../src/config/portable.js");
  const { addProject, readProjectRegistry } = await import("../src/config/projects.js");

  const project = tempDir("steerium-proj-");
  writeFileSync(join(home, "config.ts"), `export default { defaults: { provider: "mock" } };`);
  mkdirSync(join(home, "workflows", "nested"), { recursive: true });
  writeFileSync(join(home, "workflows", "a.ts"), "// workflow a");
  writeFileSync(join(home, "workflows", "nested", "b.ts"), "// workflow b");
  addProject(project);
  addProject("/no/such/path/anywhere");

  const bundleFile = join(tempDir("steerium-out-"), "bundle.json");
  const { bundle } = exportBundle(bundleFile);
  assert.equal(bundle.config?.includes("mock"), true);
  assert.deepEqual(Object.keys(bundle.workflows).sort(), ["a.ts", "nested/b.ts"]);
  assert.equal(bundle.projects.length, 2);

  // Import into a brand-new home, as if on another machine.
  const home2 = freshHome();
  const res = importBundle(parseBundle(readFileSync(bundleFile, "utf8")));

  assert.equal(readFileSync(join(home2, "config.ts"), "utf8").includes("mock"), true);
  assert.equal(existsSync(join(home2, "workflows", "nested", "b.ts")), true);
  assert.equal(res.written.length, 3, "config.ts + two workflows written");
  assert.deepEqual(res.registered, [project], "existing project registered");
  assert.deepEqual(
    res.missing,
    ["/no/such/path/anywhere"],
    "absent project reported, not registered",
  );
  assert.deepEqual(readProjectRegistry(), [project]);
});

test("config import keeps existing files unless forced", async () => {
  const home = freshHome();
  const { importBundle, parseBundle } = await import("../src/config/portable.js");
  writeFileSync(join(home, "config.ts"), "// local edits");

  const raw = JSON.stringify({
    steerium: 1,
    exportedAt: "",
    sourceHomedir: "",
    config: "// from bundle",
    workflows: {},
    projects: [],
  });

  const kept = importBundle(parseBundle(raw));
  assert.equal(kept.skipped.length, 1);
  assert.equal(readFileSync(join(home, "config.ts"), "utf8"), "// local edits");

  const forced = importBundle(parseBundle(raw), { force: true });
  assert.equal(forced.written.length, 1);
  assert.equal(readFileSync(join(home, "config.ts"), "utf8"), "// from bundle");
});

test("config import rejects bundles from a newer steerium", async () => {
  freshHome();
  const { parseBundle } = await import("../src/config/portable.js");
  assert.throws(() => parseBundle(JSON.stringify({ steerium: 999 })), /unsupported bundle/);
});
