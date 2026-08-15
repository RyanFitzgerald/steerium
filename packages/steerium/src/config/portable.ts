/**
 * Config export/import (`steerium config export|import`). Bundles the portable
 * config layer — config.ts, global workflows, and the project registry — into
 * one self-contained JSON file for moving to another machine. Machine-local
 * state (state.db, artifacts/, logs/) is deliberately excluded, and secrets
 * are env references so nothing sensitive ever lands in a bundle.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homePaths } from "../paths.js";
import { atomicWriteFileSync } from "../atomic-write.js";
import { addProject, readProjectRegistry } from "./projects.js";

export const BUNDLE_VERSION = 1;

export interface ConfigBundle {
  steerium: number;
  exportedAt: string;
  /** Home directory of the exporting machine, used to remap project paths on import. */
  sourceHomedir: string;
  /** Contents of ~/.steerium/config.ts, if present. */
  config: string | null;
  /** Global workflow files, keyed by path relative to workflows/. */
  workflows: Record<string, string>;
  /** Registered project roots (absolute paths on the source machine). */
  projects: string[];
}

/** Recursively collect files under a directory, keyed by relative path. */
function collectFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const abs = join(dir, entry);
    if (statSync(abs).isFile()) files[entry.split(sep).join("/")] = readFileSync(abs, "utf8");
  }
  return files;
}

export function buildBundle(): ConfigBundle {
  const paths = homePaths();
  return {
    steerium: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    sourceHomedir: homedir(),
    config: existsSync(paths.configFile) ? readFileSync(paths.configFile, "utf8") : null,
    workflows: collectFiles(paths.workflowsDir),
    projects: readProjectRegistry(),
  };
}

export function exportBundle(outFile: string): { file: string; bundle: ConfigBundle } {
  const bundle = buildBundle();
  const file = resolve(outFile);
  atomicWriteFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`);
  return { file, bundle };
}

export interface ImportResult {
  written: string[];
  /** Files that already existed and were left alone (no --force). */
  skipped: string[];
  registered: string[];
  /** Project roots registered under a remapped home directory. */
  remapped: Array<{ from: string; to: string }>;
  /** Project roots that exist on no path we could resolve. */
  missing: string[];
}

export function parseBundle(raw: string): ConfigBundle {
  const parsed = JSON.parse(raw) as Partial<ConfigBundle>;
  if (typeof parsed.steerium !== "number" || parsed.steerium > BUNDLE_VERSION) {
    throw new Error(
      `unsupported bundle (steerium: ${String(parsed.steerium)}) — was it made by a newer steerium?`,
    );
  }
  return {
    steerium: parsed.steerium,
    exportedAt: parsed.exportedAt ?? "",
    sourceHomedir: parsed.sourceHomedir ?? "",
    config: typeof parsed.config === "string" ? parsed.config : null,
    workflows: parsed.workflows ?? {},
    projects: parsed.projects ?? [],
  };
}

/** If `path` lives under the source machine's home dir, rebase it onto this one. */
function remapHome(path: string, sourceHomedir: string): string | null {
  if (!sourceHomedir || sourceHomedir === homedir()) return null;
  const rel = relative(sourceHomedir, path);
  if (rel.startsWith("..") || resolve(sourceHomedir, rel) !== resolve(path)) return null;
  return join(homedir(), rel);
}

function writeManaged(path: string, content: string, force: boolean, result: ImportResult): void {
  if (existsSync(path) && !force) {
    result.skipped.push(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, content);
  result.written.push(path);
}

export function importBundle(bundle: ConfigBundle, opts: { force?: boolean } = {}): ImportResult {
  const paths = homePaths();
  const force = opts.force ?? false;
  const result: ImportResult = { written: [], skipped: [], registered: [], remapped: [], missing: [] };

  mkdirSync(paths.workflowsDir, { recursive: true });
  if (bundle.config != null) writeManaged(paths.configFile, bundle.config, force, result);
  for (const [rel, content] of Object.entries(bundle.workflows)) {
    writeManaged(join(paths.workflowsDir, ...rel.split("/")), content, force, result);
  }

  for (const project of bundle.projects) {
    if (existsSync(project)) {
      addProject(project);
      result.registered.push(project);
      continue;
    }
    const remapped = remapHome(project, bundle.sourceHomedir);
    if (remapped && existsSync(remapped)) {
      addProject(remapped);
      result.registered.push(remapped);
      result.remapped.push({ from: project, to: remapped });
    } else {
      result.missing.push(project);
    }
  }

  return result;
}
