/** Argument parsing and scope resolution for the CLI. */
import { existsSync } from "node:fs";
import { homePaths, projectPaths } from "../paths.js";
import { tildify } from "./style.js";

export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

/**
 * Resolve which project (if any) a command should scope to:
 *   --project <path>  explicit;  --project  means the cwd;
 *   --global          forces global mode;
 *   otherwise, a cwd containing .steerium/ is auto-detected as project mode.
 */
export function resolveProjectFlag(args: Args, cwd = process.cwd()): string | undefined {
  if (args.flags.global === true) return undefined;
  const flag = args.flags.project;
  if (typeof flag === "string") return projectPaths(flag).root;
  if (flag === true) return projectPaths(cwd).root;
  if (cwd !== homePaths().home && existsSync(projectPaths(cwd).steeriumDir)) {
    return projectPaths(cwd).root;
  }
  return undefined;
}

/** Human label for a workflow's scope id ("global" or the project path). */
export function scopeLabel(scopeId: string): string {
  return scopeId.startsWith("project:") ? tildify(scopeId.slice("project:".length)) : scopeId;
}
