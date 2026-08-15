/** Filesystem layout helpers. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Global root. Honors STEERIUM_HOME for tests, sandboxes, server deploys. */
export function steeriumHome(): string {
  const env = process.env.STEERIUM_HOME;
  return env ? resolve(env) : join(homedir(), ".steerium");
}

export interface HomePaths {
  home: string;
  configFile: string;
  workflowsDir: string;
  db: string;
  artifactsDir: string;
  logsDir: string;
}

export function homePaths(home = steeriumHome()): HomePaths {
  return {
    home,
    configFile: join(home, "config.ts"),
    workflowsDir: join(home, "workflows"),
    db: join(home, "state.db"),
    artifactsDir: join(home, "artifacts"),
    logsDir: join(home, "logs"),
  };
}

export interface ProjectPaths {
  root: string;
  steeriumDir: string;
  configFile: string;
  workflowsDir: string;
}

export function projectPaths(root: string): ProjectPaths {
  const abs = resolve(root);
  const steeriumDir = join(abs, ".steerium");
  return {
    root: abs,
    steeriumDir,
    configFile: join(steeriumDir, "config.ts"),
    workflowsDir: join(steeriumDir, "workflows"),
  };
}

export function artifactDir(home: string, runId: string): string {
  return join(home, "artifacts", runId);
}
