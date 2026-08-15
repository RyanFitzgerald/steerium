/**
 * Workflow discovery + loading. Loads *.ts/*.js workflow files
 * from a directory and attaches the scope they run in.
 *
 * Scope/inheritance model:
 *   - Global workflows run once, in the global scope (cwd = STEERIUM_HOME).
 *   - Project workflows run in their project's scope (cwd = project root).
 *   - A project workflow whose name matches a global one OVERRIDES it for that
 *     project: the project definition is used and the global one is not also
 *     registered for that project. Globals still run in the global scope.
 *
 * Concretely, the active set the daemon registers is:
 *   all global workflows (global scope) + every project's own workflows
 *   (project scope). Un-overridden globals are not re-registered per project,
 *   so a global cron fires once, not once per project.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homePaths, projectPaths } from "../paths.js";
import { globalScope, projectScope } from "../scope.js";
import type { Scope, SteeriumConfig, WorkflowDefinition } from "../types.js";
import { loadModule } from "./load.js";
import { normalizeWorkflowDefinition } from "./normalize.js";

export interface LoadedWorkflow {
  def: WorkflowDefinition<unknown>;
  scope: Scope;
  file: string;
}

function listWorkflowFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(ts|js|mjs)$/.test(f) && !f.endsWith(".d.ts") && !f.startsWith("_"))
    .map((f) => join(dir, f))
    .sort();
}

async function loadDir(dir: string, scope: Scope): Promise<LoadedWorkflow[]> {
  const out: LoadedWorkflow[] = [];
  const names = new Map<string, string>();
  for (const file of listWorkflowFiles(dir)) {
    const def = normalizeWorkflowDefinition(await loadModule<unknown>(file), file);
    const previous = names.get(def.name);
    if (previous) throw new Error(`duplicate workflow name "${def.name}" in ${previous} and ${file}`);
    names.set(def.name, file);
    out.push({ def, scope, file });
  }
  return out;
}

/** Load all global workflows from ~/.steerium/workflows. */
export async function loadGlobalWorkflows(): Promise<LoadedWorkflow[]> {
  return loadDir(homePaths().workflowsDir, globalScope());
}

/** Load a single project's own workflow files (project scope). */
export async function loadProjectWorkflows(projectRoot: string): Promise<LoadedWorkflow[]> {
  const pp = projectPaths(projectRoot);
  return loadDir(pp.workflowsDir, projectScope(pp.root));
}

/**
 * Discover the active workflow set across the global scope and every registered
 * project, applying the per-project override rule.
 */
export async function loadAllWorkflows(config: SteeriumConfig): Promise<LoadedWorkflow[]> {
  const globals = await loadGlobalWorkflows();
  const active: LoadedWorkflow[] = [...globals];

  for (const projectRoot of config.projects ?? []) {
    if (!existsSync(projectRoot)) continue;
    active.push(...(await loadProjectWorkflows(projectRoot)));
  }
  return active;
}

/**
 * Resolve a workflow by name for a manual run. If `projectRoot` is given, a
 * project-defined workflow of that name wins over a global one (override).
 */
export async function resolveWorkflow(
  _config: SteeriumConfig,
  name: string,
  projectRoot?: string,
): Promise<LoadedWorkflow | undefined> {
  if (projectRoot) {
    const projectWfs = await loadProjectWorkflows(projectRoot);
    const hit = projectWfs.find((w) => w.def.name === name);
    if (hit) return hit;
  }
  const globals = await loadGlobalWorkflows();
  return globals.find((w) => w.def.name === name);
}
