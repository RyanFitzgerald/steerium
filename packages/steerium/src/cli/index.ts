#!/usr/bin/env node
/**
 * steerium CLI. Commands prefer a running daemon over the control API and
 * fall back to acting in-process (with triggers disabled) so single-shot
 * commands work on a laptop without `steerium start` running first.
 */
import "../quiet-sqlite.js";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homePaths, projectPaths } from "../paths.js";
import { addProject, readProjectRegistry, removeProject } from "../config/projects.js";
import { exportBundle, importBundle, parseBundle } from "../config/portable.js";
import { Daemon, type DaemonInfo } from "../runtime/daemon.js";
import type { AgentCallRecord, RunRecord, RunStepRecord } from "../types.js";
import { parseArgs, resolveProjectFlag, scopeLabel, type Args } from "./args.js";
import { controlClient, daemonReachable, tryRequest, type ControlClient } from "./client.js";
import { runDoctor } from "./doctor.js";
import { fmtRunUsage, fmtStepCalls } from "./format.js";
import { initHome, initProject } from "./scaffold.js";
import { bold, cyan, dim, fmtDuration, green, pad, red, statusColor, tildify, yellow } from "./style.js";

// Exit quietly when output is piped into something that closes early (e.g. head).
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
});

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Package version, read from package.json two levels above this module. */
function version(): string {
  try {
    const pkg = fileURLToPath(new URL("../../package.json", import.meta.url));
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version?: string }).version ?? "";
  } catch {
    return "";
  }
}

/** Indented `label  value` row for summary blocks. */
function kv(label: string, value: string): string {
  return `  ${dim(pad(label, 10))} ${value}`;
}

/** Run a function with an initialized, triggers-disabled daemon, then shut down. */
async function withDaemon<T>(fn: (d: Daemon) => Promise<T>): Promise<T> {
  const daemon = new Daemon({ triggersDisabled: true });
  await daemon.init();
  try {
    return await fn(daemon);
  } finally {
    await daemon.shutdown();
  }
}

function fmtRun(r: RunRecord): string {
  const dur = r.finished_at && r.started_at ? `${r.finished_at - r.started_at}ms` : "—";
  const when = new Date(r.created_at).toISOString();
  const status = statusColor(pad(r.status.toUpperCase(), 7));
  return `${dim(when)}  ${status} ${pad(r.workflow_name, 24)} ${dim(pad(r.trigger_kind ?? "", 18))} ${dur.padStart(8)}  ${dim(r.id)}`;
}

// ---- commands ---------------------------------------------------------------

function cmdInit(): void {
  const res = initHome();
  out();
  out(`${green("✓")} Initialized steerium home at ${bold(tildify(res.home))}`);
  for (const f of res.created) out(`    ${green("created")}  ${dim(tildify(f))}`);
  for (const f of res.skipped) out(`    ${dim("exists")}   ${dim(tildify(f))}`);
  out();
  out(`  ${bold("Next steps")}`);
  out(`    ${cyan("steerium workflow run hello")}   ${dim("try the starter workflow")}`);
  out(`    ${cyan("steerium project add <path>")}   ${dim("register a project so the daemon picks it up")}`);
  out(`    ${cyan("steerium start")}                ${dim("run the daemon (triggers + control API + UI)")}`);
  out();
  out(dim(`  Note: init scaffolds the global home only. Projects are picked up via`));
  out(dim(`  \`steerium project add\`, not init.`));
}

async function cmdProjectAdd(path: string | undefined, client: ControlClient): Promise<void> {
  if (!path) return err("usage: steerium project add <path>");
  const pp = projectPaths(path);
  const scaffold = initProject(pp.root);
  const list = addProject(pp.root);
  out();
  out(`${green("✓")} Registered project ${bold(tildify(pp.root))}`);
  for (const f of scaffold.created) out(`    ${green("created")}  ${dim(tildify(f))}`);
  out(`    ${dim(`${list.length} project(s) registered`)}`);
  if (await daemonReachable(client)) {
    out();
    out(`${yellow("!")} A steerium daemon is already running — it loads projects at startup,`);
    out(`  so it will ${bold("not")} see this project until you restart ${cyan("steerium start")}.`);
    out(`  After restarting, confirm with ${cyan("steerium status")}.`);
  } else {
    out();
    out(dim(`  It will be picked up by the next \`steerium start\`. Confirm with \`steerium status\`.`));
  }
}

function cmdProjectList(): void {
  const list = readProjectRegistry();
  if (!list.length) return out(`No projects registered. Add one with: ${cyan("steerium project add <path>")}`);
  for (const p of list) {
    const pp = projectPaths(p);
    if (!existsSync(p)) out(`  ${red("✗")} ${tildify(p)} ${dim("— path missing (skipped by the daemon)")}`);
    else if (!existsSync(pp.steeriumDir)) out(`  ${yellow("!")} ${tildify(p)} ${dim("— no .steerium/ directory")}`);
    else out(`  ${green("✓")} ${tildify(p)}`);
  }
}

function cmdConfigExport(args: Args): void {
  const outFlag = args.flags.out;
  const outFile = typeof outFlag === "string" ? outFlag : "steerium-config.json";
  const { file, bundle } = exportBundle(outFile);
  out();
  out(`${green("✓")} Exported config bundle to ${bold(tildify(file))}`);
  out(kv("config", bundle.config != null ? "config.ts" : dim("none")));
  out(kv("workflows", String(Object.keys(bundle.workflows).length)));
  out(kv("projects", String(bundle.projects.length)));
  out();
  out(dim("  Includes config.ts, global workflows, and the project registry."));
  out(dim("  Secrets are env references, so no credentials are in the bundle —"));
  out(dim("  set the same env vars on the target machine."));
  out(dim(`  Import there with: steerium config import ${tildify(file)}`));
}

function cmdConfigImport(file: string | undefined, args: Args): void {
  if (!file) return err("usage: steerium config import <file> [--force]");
  if (!existsSync(file)) return err(`${red("✗")} no such file: ${file}`);
  const bundle = parseBundle(readFileSync(file, "utf8"));
  const res = importBundle(bundle, { force: args.flags.force === true });
  out();
  out(`${green("✓")} Imported config bundle into ${bold(tildify(homePaths().home))}`);
  for (const f of res.written) out(`    ${green("written")}  ${dim(tildify(f))}`);
  for (const f of res.skipped) out(`    ${yellow("exists")}   ${dim(tildify(f))} ${dim("— kept; use --force to overwrite")}`);
  for (const p of res.registered) {
    const note = res.remapped.find((r) => r.to === p);
    out(`    ${green("project")}  ${tildify(p)}${note ? dim(` (remapped from ${note.from})`) : ""}`);
  }
  for (const p of res.missing) {
    out(`    ${red("missing")}  ${tildify(p)} ${dim("— path not found here, not registered")}`);
  }
  if (res.missing.length) {
    out();
    out(dim("  Clone the missing projects, then register them: steerium project add <path>"));
  }
  out();
  out(dim("  Remember to set the env vars your config references (steerium doctor checks)."));
}

function cmdProjectRemove(path: string | undefined): void {
  if (!path) return err("usage: steerium project remove <path>");
  const list = removeProject(path);
  out(`${green("✓")} Removed. ${list.length} project(s) remaining.`);
}

/** The `steerium start` startup summary: scope, projects picked up, workflows. */
function printStartSummary(daemon: Daemon, projectRoot: string | undefined): void {
  const info = daemon.info();
  const v = version();

  out();
  out(`  ${bold("steerium")}${v ? ` ${dim(`v${v}`)}` : ""}`);
  out();
  out(kv("scope", projectRoot ? `project ${cyan(tildify(projectRoot))}` : "global + registered projects"));
  out(kv("home", tildify(homePaths().home)));
  out(kv("control", cyan(daemon.controlUrl())));
  out(kv("ui", cyan(`${daemon.controlUrl()}/`)));

  if (!projectRoot) {
    out();
    out(`  ${bold("projects")} ${dim(`(${info.projects.length})`)}`);
    if (!info.projects.length) {
      out(dim(`    none registered — steerium project add <path>`));
    }
    for (const p of info.projects) {
      if (!p.exists) {
        out(`    ${red("✗")} ${tildify(p.root)} ${dim("— path missing, skipped")}`);
      } else if (p.workflows === 0) {
        out(`    ${yellow("!")} ${tildify(p.root)} ${dim("— picked up, but no workflows in .steerium/workflows/")}`);
      } else {
        out(`    ${green("✓")} ${tildify(p.root)} ${dim(`— ${p.workflows} workflow(s)`)}`);
      }
    }
  }

  out();
  out(`  ${bold("workflows")} ${dim(`(${info.workflows})`)}`);
  const wfs = daemon.listWorkflowSummaries();
  if (!wfs.length) out(dim("    none loaded"));
  for (const w of wfs) {
    out(`    ${green("●")} ${pad(w.name, 26)} ${dim(pad(w.triggerKind, 14))} ${dim(scopeLabel(w.scopeId))}`);
  }

  out();
  out(`  ${green("●")} ${bold("Running")} — triggers live. ${dim("Press Ctrl+C to stop.")}`);
  if (!projectRoot) {
    out(dim(`    Projects registered while the daemon runs need a restart to be picked up.`));
  }
  out();
}

async function cmdStart(args: Args): Promise<void> {
  const projectRoot = resolveProjectFlag(args);
  const daemon = new Daemon(projectRoot ? { projectRoot } : {});
  await daemon.init();
  try {
    await daemon.start();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      err(`${red("✗")} Control port is already in use — another steerium daemon is likely running.`);
      err(`  Check it with ${cyan("steerium status")}, or set a different port under \`control.port\` in config.`);
      process.exit(1);
    }
    throw e;
  }
  printStartSummary(daemon, projectRoot);

  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) {
      // Second signal: skip the grace period.
      process.exit(130);
    }
    shuttingDown = true;
    await daemon.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  // Keep the process alive.
  await new Promise<void>(() => {});
}

async function cmdWorkflowList(client: ControlClient): Promise<void> {
  const print = (wfs: Array<{ name: string; triggerKind: string; scopeId: string }>) => {
    if (!wfs.length) return out(dim("no workflows loaded"));
    out(dim(`${pad("NAME", 28)} ${pad("TRIGGER", 20)} SCOPE`));
    for (const w of wfs) {
      out(`${pad(bold(w.name), 28)} ${pad(w.triggerKind, 20)} ${dim(scopeLabel(w.scopeId))}`);
    }
  };
  if (await daemonReachable(client)) {
    const wfs = await tryRequest<Array<{ name: string; triggerKind: string; scopeId: string }>>(
      client,
      "GET",
      "/workflows",
    );
    return print(wfs ?? []);
  }
  await withDaemon(async (d) => print(d.listWorkflowSummaries()));
}

async function cmdWorkflowRun(name: string | undefined, args: Args, client: ControlClient): Promise<void> {
  if (!name) return err("usage: steerium workflow run <name> [--input <json>] [--project <path>]");
  const input = typeof args.flags.input === "string" ? JSON.parse(args.flags.input) : undefined;
  const projectRoot = resolveProjectFlag(args);

  if (await daemonReachable(client)) {
    const q = projectRoot ? `?project=${encodeURIComponent(projectRoot)}` : "";
    const res = await tryRequest<{ runId: string; status: string; error?: string }>(
      client,
      "POST",
      `/run/${encodeURIComponent(name)}${q}`,
      input ?? {},
    );
    return printFire(res);
  }
  await withDaemon(async (d) => {
    const res = await d.fire(name, input, projectRoot);
    printFire(res);
  });
}

function printFire(res: { runId: string; status: string; error?: string } | null): void {
  if (!res) return err(`${red("✗")} no response`);
  if (res.status !== "ok") {
    err(`${red("✗")} run ${res.status}: ${res.error ?? ""} ${dim(`(${res.runId})`)}`);
  } else out(`${green("✓")} run ${statusColor(res.status)}: ${dim(res.runId)}`);
}

async function cmdLogs(args: Args, client: ControlClient): Promise<void> {
  const limit = Number(args.flags.limit ?? 20);
  const follow = args.flags.follow === true;

  const fetchRuns = async (): Promise<RunRecord[]> => {
    if (await daemonReachable(client)) {
      return (await tryRequest<RunRecord[]>(client, "GET", `/runs?limit=${limit}`)) ?? [];
    }
    return withDaemon(async (d) => d.getStore().listRuns({ limit }));
  };

  const initial = await fetchRuns();
  for (const r of [...initial].reverse()) out(fmtRun(r));

  if (!follow) return;
  const seen = new Set(initial.map((r) => r.id));
  out(dim("--- following (Ctrl+C to stop) ---"));
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const runs = await fetchRuns();
    for (const r of [...runs].reverse()) {
      if (!seen.has(r.id) || r.status !== "running") {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          out(fmtRun(r));
        }
      }
    }
  }
}

async function cmdReplay(runId: string | undefined, client: ControlClient): Promise<void> {
  if (!runId) return err("usage: steerium replay <runId>");
  if (await daemonReachable(client)) {
    const res = await tryRequest<{ runId: string; status: string; error?: string }>(
      client,
      "POST",
      `/replay/${encodeURIComponent(runId)}`,
    );
    return printFire(res);
  }
  await withDaemon(async (d) => printFire(await d.replay(runId)));
}

async function cmdCancel(runId: string | undefined, client: ControlClient): Promise<void> {
  if (!runId) return err("usage: steerium cancel <runId>");
  // Cancellation only makes sense against the daemon that is executing the
  // run — there is no in-process fallback.
  if (!(await daemonReachable(client))) {
    return err("no daemon running — only a running daemon can cancel a run");
  }
  const res = await tryRequest<{ cancelled: boolean; error?: string }>(
    client,
    "POST",
    `/runs/${encodeURIComponent(runId)}/cancel`,
  );
  if (res?.cancelled) out(`${green("✓")} run ${runId.slice(0, 8)} cancelled`);
  else err(res?.error ?? "run is not executing");
}

async function cmdStatus(client: ControlClient): Promise<void> {
  if (!(await daemonReachable(client))) {
    out(`${dim("○")} daemon ${bold("not running")} ${dim(`(would listen on ${client.base})`)}`);
    const registered = readProjectRegistry();
    if (registered.length) {
      out(`  ${registered.length} registered project(s) will be picked up by the next ${cyan("steerium start")}:`);
      for (const p of registered) out(dim(`    ${tildify(p)}`));
    }
    return;
  }

  const info = await tryRequest<DaemonInfo>(client, "GET", "/status");
  if (!info) {
    // Older daemon without /status: fall back to counting workflows.
    out(`${green("●")} daemon ${bold("running")} at ${cyan(client.base)}`);
    const wfs = await tryRequest<unknown[]>(client, "GET", "/workflows");
    out(kv("workflows", String(wfs?.length ?? 0)));
    return;
  }

  const uptime = fmtDuration(Date.now() - info.startedAt);
  out(`${green("●")} daemon ${bold("running")} at ${cyan(client.base)} ${dim(`(pid ${info.pid}, up ${uptime})`)}`);
  out(kv("scope", info.mode === "project" ? `project ${tildify(info.projectRoot ?? "")}` : "global + registered projects"));
  out(kv("workflows", String(info.workflows)));

  if (info.mode === "global") {
    out(`  ${dim("projects picked up at startup:")}`);
    if (!info.projects.length) out(dim(`    none — steerium project add <path>, then restart`));
    for (const p of info.projects) {
      if (!p.exists) out(`    ${red("✗")} ${tildify(p.root)} ${dim("— path missing, skipped")}`);
      else if (p.workflows === 0) out(`    ${yellow("!")} ${tildify(p.root)} ${dim("— loaded, no workflows")}`);
      else out(`    ${green("✓")} ${tildify(p.root)} ${dim(`— ${p.workflows} workflow(s)`)}`);
    }
    // Projects registered after the daemon started are invisible to it.
    const loaded = new Set(info.projects.map((p) => p.root));
    const pending = readProjectRegistry().filter((p) => !loaded.has(p));
    if (pending.length) {
      out();
      out(`${yellow("!")} Registered after the daemon started — ${bold("not")} picked up until it restarts:`);
      for (const p of pending) out(`    ${yellow("!")} ${tildify(p)}`);
    }
  }
}

async function cmdDoctor(): Promise<void> {
  const { lines, ok } = await runDoctor();
  for (const l of lines) out(`${l.ok ? green("✓") : red("✗")} ${pad(bold(l.label), 22)} ${dim(l.detail)}`);
  out("");
  out(ok ? `${green("✓")} All checks passed.` : `${red("✗")} Some checks need attention.`);
  if (!ok) process.exitCode = 1;
}

function printRunDetail(
  run: RunRecord,
  steps: RunStepRecord[],
  agentCalls: AgentCallRecord[] = [],
): void {
  out(fmtRun(run));
  if (run.error) out(`  ${red("error:")} ${run.error}`);
  const byStep = new Map<string, AgentCallRecord[]>();
  for (const c of agentCalls) {
    if (!c.step_id) continue;
    const list = byStep.get(c.step_id) ?? [];
    list.push(c);
    byStep.set(c.step_id, list);
  }
  for (const s of steps) {
    const mark = s.status === "ok" ? green("✓") : s.status === "running" ? yellow("●") : red("✗");
    out(`  ${mark} step ${pad(s.name, 20)} ${statusColor(s.status)}${fmtStepCalls(byStep.get(s.id) ?? [])}`);
    if (s.error) out(`      ${red("error:")} ${s.error}`);
  }
  const outside = agentCalls.filter((c) => !c.step_id);
  if (outside.length) {
    out(`  ${dim("· outside steps")}          ${fmtStepCalls(outside).trim()}`);
  }
  const usageLines = fmtRunUsage(agentCalls, steps.length);
  if (usageLines.length) {
    out("");
    for (const line of usageLines) out(line);
  }
}

function usage(): void {
  const cmd = (name: string, desc: string) => `  ${cyan(pad(name, 27))}${desc}`;
  out(`${bold("steerium")} — local-first, code-defined workflow runner

${bold("Usage:")} steerium <command> [options]

${cmd("init", "scaffold ~/.steerium + starter workflows")}
${cmd("project add <path>", "register a project (a running daemon needs a restart to see it)")}
${cmd("project list", "list registered projects")}
${cmd("project remove <path>", "unregister a project")}
${cmd("config export", `bundle config + workflows + registry  ${dim("[--out <file>]")}`)}
${cmd("config import <file>", `restore a bundle on this machine      ${dim("[--force]")}`)}
${cmd("start", "run the daemon (registers triggers, serves control API)")}
${cmd("", dim("[--project [path]] scope to one project; [--global] force global."))}
${cmd("", dim("a cwd containing .steerium/ is auto-detected as project scope"))}
${cmd("workflow list", "list registered workflows")}
${cmd("workflow run <name>", `fire one workflow once   ${dim("[--input <json>] [--project <path>]")}`)}
${cmd("logs", `recent run history       ${dim("[--limit <n>] [--follow]")}`)}
${cmd("run <runId>", "show run detail + steps")}
${cmd("replay <runId>", "re-run a workflow against its stored event")}
${cmd("cancel <runId>", "abort an executing run (requires a running daemon)")}
${cmd("status", "query a running daemon (scope, projects picked up, workflows)")}
${cmd("doctor", "check Node version, provider auth, connector config")}
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, sub] = args._;
  const client = await controlClient();

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return usage();
    case "init":
      return cmdInit();
    case "project":
      if (sub === "add") return cmdProjectAdd(args._[2], client);
      if (sub === "list") return cmdProjectList();
      if (sub === "remove") return cmdProjectRemove(args._[2]);
      return err("usage: steerium project <add|list|remove> [path]");
    case "config":
      if (sub === "export") return cmdConfigExport(args);
      if (sub === "import") return cmdConfigImport(args._[2], args);
      return err("usage: steerium config <export|import> [file]");
    case "start":
      return cmdStart(args);
    case "workflow":
      if (sub === "list") return cmdWorkflowList(client);
      if (sub === "run") return cmdWorkflowRun(args._[2], args, client);
      return err("usage: steerium workflow <list|run> [name]");
    case "logs":
      return cmdLogs(args, client);
    case "run": {
      // `steerium run <runId>` shows a run's detail.
      const id = sub;
      if (!id) return err("usage: steerium run <runId>");
      return withDaemon(async (d) => {
        const store = d.getStore();
        const run = store.getRun(id);
        if (!run) return err(`unknown run ${id}`);
        printRunDetail(run, store.listSteps(id), store.listAgentCalls(id));
      });
    }
    case "cancel":
      return cmdCancel(sub, client);
    case "replay":
      return cmdReplay(sub, client);
    case "status":
      return cmdStatus(client);
    case "doctor":
      return cmdDoctor();
    default:
      err(`unknown command: ${cmd}`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((e) => {
  err(String(e instanceof Error ? e.stack ?? e.message : e));
  process.exit(1);
});
