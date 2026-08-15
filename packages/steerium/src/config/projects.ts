/**
 * Project registry (`steerium project add` / `project list`). Stored as JSON next to
 * config.ts so it can be edited programmatically without rewriting TypeScript.
 * The loader unions these with any `projects` listed in config.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { homePaths } from "../paths.js";
import { atomicWriteFileSync } from "../atomic-write.js";

function registryFile(): string {
  return join(homePaths().home, "projects.json");
}

export function readProjectRegistry(): string[] {
  const file = registryFile();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { projects?: string[] };
    return parsed.projects ?? [];
  } catch {
    return [];
  }
}

function writeProjectRegistry(projects: string[]): void {
  atomicWriteFileSync(registryFile(), `${JSON.stringify({ projects }, null, 2)}\n`);
}

/** Add a project root; returns the updated, de-duplicated list. */
export function addProject(path: string): string[] {
  const abs = resolve(path);
  const current = readProjectRegistry();
  if (!current.includes(abs)) current.push(abs);
  writeProjectRegistry(current);
  return current;
}

export function removeProject(path: string): string[] {
  const abs = resolve(path);
  const next = readProjectRegistry().filter((p) => p !== abs);
  writeProjectRegistry(next);
  return next;
}
