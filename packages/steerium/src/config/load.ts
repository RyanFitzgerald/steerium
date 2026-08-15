/**
 * Config loading + cascade. User config and workflow files are
 * TypeScript loaded at runtime with `jiti`, so end users never run a build step.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createJiti, type Jiti } from "jiti";
import { homePaths, projectPaths } from "../paths.js";
import type { SteeriumConfig } from "../types.js";
import { normalizeConfig } from "./normalize.js";
import { readProjectRegistry } from "./projects.js";

/**
 * Absolute path to this package's built entry. User config and workflow files
 * `import ... from "steerium"`; that bare specifier won't resolve from inside
 * an arbitrary STEERIUM_HOME, so we alias it to our own entry for jiti. This
 * module sits at dist/config/load.js (or src/config/load.ts in dev), so the
 * package root is two levels up and the entry is dist/index.js.
 */
function steeriumEntry(): string {
  return fileURLToPath(new URL("../../dist/index.js", import.meta.url));
}

let _jiti: Jiti | undefined;
function jiti(): Jiti {
  if (!_jiti) {
    _jiti = createJiti(import.meta.url, {
      interopDefault: true,
      alias: { steerium: steeriumEntry() },
    });
  }
  return _jiti;
}

/** Load a default-exported value from a .ts/.js file via jiti. */
export async function loadModule<T>(path: string): Promise<T> {
  const mod = (await jiti().import(path)) as { default?: T } | T;
  return ((mod as { default?: T }).default ?? mod) as T;
}

const BUILTIN_DEFAULTS: SteeriumConfig = {
  defaults: { provider: "mock", concurrency: 1, timeoutMs: 5 * 60_000 },
  control: { host: "127.0.0.1", port: 4319 },
};

async function loadConfigFile(file: string): Promise<SteeriumConfig> {
  if (!existsSync(file)) return {};
  try {
    return normalizeConfig(await loadModule<unknown>(file), file);
  } catch (err) {
    throw new Error(`Failed to load config ${file}: ${String(err)}`);
  }
}

function mergeConfig(base: SteeriumConfig, over: SteeriumConfig): SteeriumConfig {
  return {
    providers: { ...base.providers, ...over.providers },
    connectors: mergeConnectors(base.connectors, over.connectors),
    projects: over.projects ?? base.projects,
    defaults: { ...base.defaults, ...over.defaults },
    control: { ...base.control, ...over.control },
  };
}

function mergeConnectors(
  base: SteeriumConfig["connectors"],
  over: SteeriumConfig["connectors"],
): SteeriumConfig["connectors"] {
  const out: NonNullable<SteeriumConfig["connectors"]> = { ...base };
  for (const [name, settings] of Object.entries(over ?? {})) {
    out[name] = { ...(out[name] ?? {}), ...settings };
  }
  return out;
}

export interface LoadedConfig {
  /** Global config merged over built-in defaults. */
  global: SteeriumConfig;
  /** The global config file path (may not exist). */
  globalFile: string;
}

/** Load built-in defaults <- global config. */
export async function loadGlobalConfig(): Promise<LoadedConfig> {
  const paths = homePaths();
  const fileConfig = await loadConfigFile(paths.configFile);
  const merged = mergeConfig(BUILTIN_DEFAULTS, fileConfig);
  // Union projects from config.ts with the JSON registry (steerium project add).
  const registered = readProjectRegistry();
  merged.projects = [...new Set([...(merged.projects ?? []), ...registered])];
  return { global: merged, globalFile: paths.configFile };
}

/**
 * Resolve the effective config for a project scope: global merged with the
 * project's own config (project wins).
 */
export async function loadProjectConfig(
  global: SteeriumConfig,
  projectRoot: string,
): Promise<SteeriumConfig> {
  const pp = projectPaths(projectRoot);
  const projectConfig = await loadConfigFile(pp.configFile);
  return mergeConfig(global, projectConfig);
}

export { BUILTIN_DEFAULTS };
