/** Scope construction. */
import { steeriumHome } from "./paths.js";
import type { Scope } from "./types.js";

export function globalScope(home = steeriumHome()): Scope {
  return { kind: "global", id: "global", cwd: home };
}

export function projectScope(projectRoot: string): Scope {
  return {
    kind: "project",
    id: `project:${projectRoot}`,
    cwd: projectRoot,
    projectRoot,
  };
}
