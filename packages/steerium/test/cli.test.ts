/**
 * CLI end-to-end.
 *
 * These spawn the built `dist/cli/index.js` — the exact file the `steerium` bin
 * points at — rather than importing the module, because index.ts runs main() on
 * import and because the shipped entry is what users actually get. The suite
 * already requires a build (workflow files resolve `steerium` to dist/), so
 * this adds no new prerequisite.
 *
 * Each case gets its own STEERIUM_HOME and a control port nothing is listening
 * on, so commands take the "no daemon reachable" in-process fallback instead of
 * talking to a daemon the developer happens to have running.
 */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freePort, freshProject, tempDir, writeProjectWorkflow } from "./helpers.js";

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));

interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
  /** stdout + stderr, for assertions that don't care which stream carried it. */
  all: string;
}

/** A home with workflows/ ready and the control server pointed at a closed port. */
async function cliHome(): Promise<string> {
  const home = tempDir("steerium-cli-");
  mkdirSync(join(home, "workflows"), { recursive: true });
  const port = await freePort(); // allocated then released — nothing is listening
  writeFileSync(
    join(home, "config.ts"),
    `import { defineConfig } from "steerium";
     export default defineConfig({ defaults: { provider: "mock" }, control: { port: ${port} } });`,
    "utf8",
  );
  return home;
}

async function steerium(
  args: string[],
  opts: {
    home: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    STEERIUM_HOME: opts.home,
    NO_COLOR: "1",
    ...opts.env,
  };
  // An explicit undefined means "unset", which spreading alone would not do.
  for (const [k, v] of Object.entries(opts.env ?? {})) if (v === undefined) delete env[k];

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: opts.cwd ?? opts.home,
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0, all: stdout + stderr };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    const stdout = e.stdout ?? "";
    const stderr = e.stderr ?? "";
    return { stdout, stderr, code: e.code ?? 1, all: stdout + stderr };
  }
}

// ---- help and dispatch ---------------------------------------------------------

test("help lists every command, and bare invocation prints it too", async () => {
  const home = await cliHome();
  const help = await steerium(["help"], { home });
  assert.equal(help.code, 0);
  for (const cmd of [
    "init",
    "project add",
    "config export",
    "config import",
    "start",
    "workflow list",
    "workflow run",
    "logs",
    "replay",
    "cancel",
    "status",
    "doctor",
  ]) {
    assert.ok(help.stdout.includes(cmd), `usage should document "${cmd}"`);
  }

  const bare = await steerium([], { home });
  assert.equal(bare.stdout, help.stdout, "no args must behave like `help`");
  assert.equal((await steerium(["--help"], { home })).stdout, help.stdout);
});

test("an unknown command exits non-zero and shows usage", async () => {
  const home = await cliHome();
  const res = await steerium(["frobnicate"], { home });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /unknown command: frobnicate/);
  assert.match(res.stdout, /Usage: steerium/);
});

test("subcommands report their own usage when the verb is missing or wrong", async () => {
  const home = await cliHome();
  assert.match((await steerium(["project"], { home })).stderr, /usage: steerium project/);
  assert.match((await steerium(["config", "nope"], { home })).stderr, /usage: steerium config/);
  assert.match((await steerium(["workflow"], { home })).stderr, /usage: steerium workflow/);
  assert.match(
    (await steerium(["workflow", "run"], { home })).stderr,
    /usage: steerium workflow run/,
  );
  assert.match((await steerium(["run"], { home })).stderr, /usage: steerium run <runId>/);
  assert.match((await steerium(["replay"], { home })).stderr, /usage: steerium replay/);
});

// ---- init ----------------------------------------------------------------------

test("init scaffolds the home and is idempotent on a second run", async () => {
  const home = tempDir("steerium-cli-");
  const first = await steerium(["init"], { home });
  assert.equal(first.code, 0);
  assert.match(first.stdout, /Initialized steerium home/);
  for (const f of ["config.ts", "workflows/hello.ts", "workflows/daily-blog.ts"]) {
    assert.ok(existsSync(join(home, f)), `${f} should exist`);
  }
  assert.ok(existsSync(join(home, "artifacts")));
  assert.ok(existsSync(join(home, "logs")));

  // A local edit must survive re-running init.
  writeFileSync(join(home, "workflows", "hello.ts"), "// my edits", "utf8");
  const second = await steerium(["init"], { home });
  assert.match(second.stdout, /exists/);
  assert.equal(readFileSync(join(home, "workflows", "hello.ts"), "utf8"), "// my edits");
});

// ---- workflows -----------------------------------------------------------------

/** A home with init's scaffolding, minus the cron workflow (it needs a key). */
async function homeWithHello(): Promise<string> {
  const home = await cliHome();
  writeFileSync(
    join(home, "workflows", "hello.ts"),
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "hello", on: manual(),
       async run(ctx) {
         const res = await ctx.step("greet", () => ctx.agent.run({ prompt: "hi there" }));
         await ctx.artifact.writeText("hello.txt", res.text);
       } });`,
    "utf8",
  );
  return home;
}

test("workflow list falls back in-process when no daemon is reachable", async () => {
  const home = await homeWithHello();
  const res = await steerium(["workflow", "list"], { home });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /NAME\s+TRIGGER\s+SCOPE/);
  assert.match(res.stdout, /hello\s+manual\s+global/);
});

test("workflow run fires the workflow and records a run with its artifact", async () => {
  const home = await homeWithHello();
  const res = await steerium(["workflow", "run", "hello"], { home });
  assert.equal(res.code, 0, res.all);
  assert.match(res.stdout, /run ok:/);

  const runId = res.stdout.trim().split(/\s+/).pop()!;
  assert.match(runId, /^[0-9a-f-]{36}$/, "the run id should be printed for follow-up commands");
  assert.equal(
    readFileSync(join(home, "artifacts", runId, "hello.txt"), "utf8"),
    "[mock:default] hi there",
  );
});

test("workflow run --input reaches the workflow as ctx.event.input", async () => {
  const home = await cliHome();
  writeFileSync(
    join(home, "workflows", "echo.ts"),
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "echo", on: manual(),
       async run(ctx) { await ctx.artifact.writeText("in.json", JSON.stringify(ctx.event.input ?? {})); } });`,
    "utf8",
  );
  const res = await steerium(
    ["workflow", "run", "echo", "--input", '{"url":"https://example.com"}'],
    { home },
  );
  assert.equal(res.code, 0, res.all);
  const runId = res.stdout.trim().split(/\s+/).pop()!;
  assert.deepEqual(JSON.parse(readFileSync(join(home, "artifacts", runId, "in.json"), "utf8")), {
    url: "https://example.com",
  });
});

test("a workflow that throws is reported as a run error on stderr", async () => {
  const home = await cliHome();
  writeFileSync(
    join(home, "workflows", "bad.ts"),
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "bad", on: manual(),
       async run() { throw new Error("boom"); } });`,
    "utf8",
  );
  const res = await steerium(["workflow", "run", "bad"], { home });
  assert.match(res.stderr, /run failed: .*boom/);
});

// ---- run detail and logs -------------------------------------------------------

test("run <id> shows steps and the token accounting for its agent calls", async () => {
  const home = await homeWithHello();
  const fired = await steerium(["workflow", "run", "hello"], { home });
  const runId = fired.stdout.trim().split(/\s+/).pop()!;

  const res = await steerium(["run", runId], { home });
  assert.equal(res.code, 0, res.all);
  assert.match(res.stdout, /step greet/);
  assert.match(res.stdout, /agent: mock/);
  // The mock provider reports usage, so a real number must appear — not "unknown".
  assert.match(res.stdout, /tokens: \d+ total —/);
  assert.match(res.stdout, /0 of 1 steps deterministic/);
});

test("run <id> renders unreported usage as unknown rather than zero", async () => {
  const home = await cliHome();
  writeFileSync(
    join(home, "config.ts"),
    `import { defineConfig, defineProvider } from "steerium";
     const quiet = defineProvider({ name: "quiet", async run() { return { text: "no usage here" }; } });
     export default defineConfig({ defaults: { provider: "quiet" }, providers: { quiet }, control: { port: 1 } });`,
    "utf8",
  );
  writeFileSync(
    join(home, "workflows", "q.ts"),
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "q", on: manual(),
       async run(ctx) { await ctx.step("s", () => ctx.agent.run({ prompt: "x" })); } });`,
    "utf8",
  );
  const fired = await steerium(["workflow", "run", "q"], { home });
  const runId = fired.stdout.trim().split(/\s+/).pop()!;
  const res = await steerium(["run", runId], { home });
  assert.match(res.stdout, /tokens: unknown \(provider did not report usage\)/);
  assert.ok(!/tokens: 0 total/.test(res.stdout), "0 must never stand in for unknown");
});

test("run <id> for an unknown id says so instead of printing an empty report", async () => {
  const home = await cliHome();
  const res = await steerium(["run", "no-such-run"], { home });
  assert.match(res.stderr, /unknown run no-such-run/);
});

test("logs lists recent runs oldest-first and honors --limit", async () => {
  const home = await homeWithHello();
  await steerium(["workflow", "run", "hello"], { home });
  await steerium(["workflow", "run", "hello"], { home });
  await steerium(["workflow", "run", "hello"], { home });

  const all = await steerium(["logs"], { home });
  assert.equal(all.stdout.trim().split("\n").length, 3);
  assert.match(all.stdout, /OK\s+hello/);

  const limited = await steerium(["logs", "--limit", "2"], { home });
  assert.equal(limited.stdout.trim().split("\n").length, 2);
});

test("replay re-runs a workflow against its stored event", async () => {
  const home = await cliHome();
  writeFileSync(
    join(home, "workflows", "echo.ts"),
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "echo", on: manual(),
       async run(ctx) { await ctx.artifact.writeText("in.json", JSON.stringify(ctx.event.input ?? {})); } });`,
    "utf8",
  );
  const first = await steerium(["workflow", "run", "echo", "--input", '{"n":1}'], { home });
  const firstId = first.stdout.trim().split(/\s+/).pop()!;

  const replayed = await steerium(["replay", firstId], { home });
  assert.equal(replayed.code, 0, replayed.all);
  const replayId = replayed.stdout.trim().split(/\s+/).pop()!;
  assert.notEqual(replayId, firstId, "a replay is a new run");
  // Same event, so the same input is seen again.
  assert.deepEqual(JSON.parse(readFileSync(join(home, "artifacts", replayId, "in.json"), "utf8")), {
    n: 1,
  });
});

// ---- projects ------------------------------------------------------------------

test("project add scaffolds, registers, and shows up in project list", async () => {
  const home = await cliHome();
  const proj = tempDir("steerium-proj-");

  const added = await steerium(["project", "add", proj], { home });
  assert.equal(added.code, 0, added.all);
  assert.match(added.stdout, /Registered project/);
  assert.ok(existsSync(join(proj, ".steerium", "workflows", "project-hello.ts")));
  assert.ok(existsSync(join(home, "projects.json")));

  const listed = await steerium(["project", "list"], { home });
  assert.ok(listed.stdout.includes(proj) || listed.stdout.includes("✓"), listed.all);

  const removed = await steerium(["project", "remove", proj], { home });
  assert.match(removed.stdout, /0 project\(s\) remaining/);
  assert.match((await steerium(["project", "list"], { home })).stdout, /No projects registered/);
});

test("project list flags a registered path that has since disappeared", async () => {
  const home = await cliHome();
  writeFileSync(
    join(home, "projects.json"),
    JSON.stringify({ projects: ["/no/such/path/anywhere"] }),
    "utf8",
  );
  const res = await steerium(["project", "list"], { home });
  assert.match(res.stdout, /path missing/);
});

test("--project scopes a run to that project's workflows", async () => {
  const home = await cliHome();
  const proj = freshProject();
  writeProjectWorkflow(
    proj,
    "only",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "only", on: manual(),
       async run(ctx) { await ctx.artifact.writeText("scope.txt", ctx.scope.id); } });`,
  );
  await steerium(["project", "add", proj], { home });

  const res = await steerium(["workflow", "run", "only", "--project", proj], {
    home,
  });
  assert.equal(res.code, 0, res.all);
  const runId = res.stdout.trim().split(/\s+/).pop()!;
  assert.match(readFileSync(join(home, "artifacts", runId, "scope.txt"), "utf8"), /^project:/);
});

test("a cwd containing .steerium/ is auto-detected as project scope", async () => {
  const home = await cliHome();
  const proj = freshProject();
  writeProjectWorkflow(
    proj,
    "auto",
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "auto", on: manual(), async run() {} });`,
  );
  await steerium(["project", "add", proj], { home });

  // Run from inside the project, with no --project flag.
  const res = await steerium(["workflow", "list"], { home, cwd: proj });
  assert.match(res.stdout, /auto/);
});

// ---- config bundles ------------------------------------------------------------

test("config export then import round-trips onto a fresh home", async () => {
  const home = await cliHome();
  writeFileSync(
    join(home, "workflows", "w.ts"),
    `import { defineWorkflow, manual } from "steerium";
     export default defineWorkflow({ name: "w", on: manual(), async run() {} });`,
    "utf8",
  );
  const bundle = join(tempDir("steerium-out-"), "bundle.json");
  const exported = await steerium(["config", "export", "--out", bundle], {
    home,
  });
  assert.equal(exported.code, 0, exported.all);
  assert.match(exported.stdout, /Exported config bundle/);
  assert.ok(existsSync(bundle));

  const home2 = tempDir("steerium-cli-");
  const imported = await steerium(["config", "import", bundle], {
    home: home2,
  });
  assert.equal(imported.code, 0, imported.all);
  assert.ok(existsSync(join(home2, "workflows", "w.ts")));
  assert.ok(readFileSync(join(home2, "config.ts"), "utf8").includes("defineConfig"));

  // A second import keeps local files unless forced.
  writeFileSync(join(home2, "workflows", "w.ts"), "// local", "utf8");
  await steerium(["config", "import", bundle], { home: home2 });
  assert.equal(readFileSync(join(home2, "workflows", "w.ts"), "utf8"), "// local");
  await steerium(["config", "import", bundle, "--force"], { home: home2 });
  assert.match(readFileSync(join(home2, "workflows", "w.ts"), "utf8"), /defineWorkflow/);
});

test("config import on a missing file fails with a clear message", async () => {
  const home = await cliHome();
  const res = await steerium(["config", "import", "/no/such/bundle.json"], {
    home,
  });
  assert.match(res.stderr, /no such file/);
});

// ---- status, doctor, cancel ----------------------------------------------------

test("status reports no daemon and names the port it would use", async () => {
  const home = await cliHome();
  const res = await steerium(["status"], { home });
  assert.equal(res.code, 0);
  assert.match(res.stdout, /daemon not running/);
  assert.match(res.stdout, /would listen on http:\/\/127\.0\.0\.1:\d+/);
});

test("status lists projects waiting for the next start", async () => {
  const home = await cliHome();
  const proj = tempDir("steerium-proj-");
  await steerium(["project", "add", proj], { home });
  const res = await steerium(["status"], { home });
  assert.match(res.stdout, /registered project\(s\) will be picked up/);
});

test("doctor probes every registered provider, not just the configured default", async () => {
  // Even with defaults.provider = "mock", doctor reports on all five built-ins:
  // the point of the command is to tell you what would happen if you switched.
  const home = await cliHome();
  const res = await steerium(["doctor"], { home });
  assert.match(res.stdout, /Node v?\d+/);
  assert.match(res.stdout, /provider mock\s+mock/);
  for (const p of ["openai", "anthropic", "codex", "claude"]) {
    assert.match(res.stdout, new RegExp(`provider ${p}\\s+\\S`), `doctor should probe ${p}`);
  }
});

test("doctor flips the API providers to ok once their keys are in the environment", async () => {
  // Asserted per-line rather than on the exit code: codex/claude resolve
  // against optional SDKs that may or may not be installed on a given machine,
  // so an overall "All checks passed" is not a stable expectation.
  const home = await cliHome();
  const before = await steerium(["doctor"], {
    home,
    env: { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
  });
  assert.match(before.stdout, /✗ provider openai\s+missing/);
  assert.match(before.stdout, /✗ provider anthropic\s+missing/);

  const after = await steerium(["doctor"], {
    home,
    env: { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-test" },
  });
  assert.match(after.stdout, /✓ provider openai\s+api-key/);
  assert.match(after.stdout, /✓ provider anthropic\s+api-key/);
});

test("doctor exits non-zero when a configured provider has no credentials", async () => {
  const home = tempDir("steerium-cli-");
  mkdirSync(join(home, "workflows"), { recursive: true });
  writeFileSync(
    join(home, "config.ts"),
    `import { defineConfig } from "steerium";
     export default defineConfig({
       providers: { anthropic: { apiKey: { env: "STEERIUM_DEFINITELY_UNSET_KEY" } } },
       control: { port: 1 },
     });`,
    "utf8",
  );
  const res = await steerium(["doctor"], { home });
  assert.equal(res.code, 1, "a failing check must be visible to CI");
  assert.match(res.stdout, /Some checks need attention/);
  assert.match(res.stdout, /provider anthropic\s+missing/);
});

test("doctor reports configured connectors", async () => {
  const home = tempDir("steerium-cli-");
  mkdirSync(join(home, "workflows"), { recursive: true });
  writeFileSync(
    join(home, "config.ts"),
    `import { defineConfig } from "steerium";
     export default defineConfig({
       connectors: { linear: { apiKey: { env: "LINEAR_API_KEY" } } },
       control: { port: 1 },
     });`,
    "utf8",
  );
  const res = await steerium(["doctor"], { home });
  assert.match(res.stdout, /connector linear\s+configured: apiKey/);
});

test("cancel without a running daemon explains why it cannot work", async () => {
  const home = await cliHome();
  const res = await steerium(["cancel", "some-run-id"], { home });
  assert.match(res.stderr, /no daemon running/);
});
