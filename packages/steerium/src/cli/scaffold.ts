/**
 * `steerium init` scaffolding. Creates ~/.steerium/ and copies
 * bundled starter workflows in as ordinary, editable global workflows. "Ship
 * some out of the box" is just files, not magic.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homePaths } from "../paths.js";
import { atomicWriteFileSync } from "../atomic-write.js";

const CONFIG_TEMPLATE = `import { defineConfig } from "steerium";

/**
 * Global steerium config. Project-level .steerium/config.ts files are merged
 * over this one (project wins). Secrets are env references, never literals.
 */
export default defineConfig({
  defaults: {
    // The mock provider needs no credentials. Switch to "openai"/"anthropic"
    // once you set the matching API key, or "codex"/"claude" on a laptop.
    provider: "mock",
  },
  providers: {
    // API providers are metered and need a key:
    // openai: { apiKey: { env: "OPENAI_API_KEY" }, model: "gpt-4o" },
    // anthropic: { apiKey: { env: "ANTHROPIC_API_KEY" }, model: "claude-opus-4-8" },
    // Agent providers ("claude"/"codex") need no key here — they drive the CLI
    // you already have installed and use its login. Without permissionMode they
    // run read-only; "acceptEdits" lets them edit files. \`steerium doctor\`
    // shows what each provider resolved to.
    // claude: { permissionMode: "acceptEdits", allowedTools: ["Read", "Edit", "Bash"] },
    // codex: { permissionMode: "acceptEdits" },
  },
  connectors: {
    // Poll mode (default) needs only the API key. For webhook mode set
    // \`webhook: true\` and a \`webhookSecret\` — connectors reject unsigned payloads.
    // linear: { apiKey: { env: "LINEAR_API_KEY" }, webhook: false, webhookSecret: { env: "LINEAR_WEBHOOK_SECRET" } },
    // jira: { host: "https://your-org.atlassian.net", email: { env: "JIRA_EMAIL" }, apiToken: { env: "JIRA_API_TOKEN" }, webhookSecret: { env: "JIRA_WEBHOOK_SECRET" } },
  },
  // Registered with \`steerium project add <path>\`.
  projects: [],
  control: { host: "127.0.0.1", port: 4319 },
});
`;

const HELLO_TEMPLATE = `import { defineWorkflow, manual } from "steerium";

/**
 * Smallest possible workflow: fired manually, runs against the mock provider so
 * it works with zero credentials. Try: \`steerium workflow run hello\`.
 */
export default defineWorkflow({
  name: "hello",
  on: manual(),
  async run(ctx) {
    const res = await ctx.step("greet", () =>
      ctx.agent.run({ prompt: "Say hello from steerium in one short sentence." }),
    );
    ctx.logger.info(res.text);
    await ctx.artifact.writeText("hello.txt", res.text);
  },
});
`;

const DAILY_BLOG_TEMPLATE = `import { defineWorkflow, schedule } from "steerium";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Global cron workflow. Runs once in the global scope (cwd = STEERIUM_HOME).
 * Edit, or delete this file if you don't want it.
 */
export default defineWorkflow({
  name: "daily-blog",
  on: schedule.cron("0 14 * * *", { tz: "America/Montreal" }),
  async run(ctx) {
    const post = await ctx.step("write", () =>
      ctx.agent.run({
        provider: "anthropic",
        system: "Concise technical blogger. Markdown only.",
        prompt: "Write a 600-word post on a practical software engineering idea.",
      }),
    );
    const dir = join(ctx.scope.cwd, "posts");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, \`\${new Date().toISOString().slice(0, 10)}.md\`), post.text);
  },
});
`;

export interface InitResult {
  home: string;
  created: string[];
  skipped: string[];
}

function writeIfAbsent(path: string, content: string, result: InitResult): void {
  if (existsSync(path)) {
    result.skipped.push(path);
    return;
  }
  atomicWriteFileSync(path, content);
  result.created.push(path);
}

export function initHome(): InitResult {
  const paths = homePaths();
  const result: InitResult = { home: paths.home, created: [], skipped: [] };

  for (const dir of [paths.home, paths.workflowsDir, paths.artifactsDir, paths.logsDir]) {
    mkdirSync(dir, { recursive: true });
  }

  writeIfAbsent(paths.configFile, CONFIG_TEMPLATE, result);
  writeIfAbsent(join(paths.workflowsDir, "hello.ts"), HELLO_TEMPLATE, result);
  writeIfAbsent(join(paths.workflowsDir, "daily-blog.ts"), DAILY_BLOG_TEMPLATE, result);

  return result;
}

const PROJECT_HELLO_TEMPLATE = `import { defineWorkflow, manual } from "steerium";

export default defineWorkflow({
  name: "project-hello",
  on: manual(),
  async run(ctx) {
    ctx.logger.info(\`hello from project at \${ctx.scope.cwd}\`);
    const res = await ctx.step("greet", () =>
      ctx.agent.run({ prompt: \`Summarize what kind of project lives at \${ctx.scope.cwd} in one line.\` }),
    );
    await ctx.artifact.writeText("greeting.txt", res.text);
  },
});
`;

/** Scaffold a project's .steerium/ folder when it is first added. */
export function initProject(projectRoot: string): InitResult {
  const result: InitResult = { home: projectRoot, created: [], skipped: [] };
  const steeriumDir = join(projectRoot, ".steerium");
  const workflowsDir = join(steeriumDir, "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeIfAbsent(join(workflowsDir, "project-hello.ts"), PROJECT_HELLO_TEMPLATE, result);
  return result;
}
