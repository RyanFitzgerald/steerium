/**
 * Deterministic-only workflow — no AI calls at all. Workflows are plain
 * TypeScript, so "automation" doesn't have to mean "agent": this one prunes
 * merged branches and records what it did, on an interval.
 */
import { defineWorkflow, schedule } from "steerium";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export default defineWorkflow({
  name: "repo-housekeeping",
  on: schedule.every(6 * 60 * 60_000), // every 6 hours
  async run(ctx) {
    const pruned = await ctx.step("prune-merged-branches", async () => {
      await exec("git", ["fetch", "--prune"], { cwd: ctx.scope.cwd });
      const { stdout } = await exec("git", ["branch", "--merged", "main"], {
        cwd: ctx.scope.cwd,
      });
      const branches = stdout
        .split("\n")
        .map((b) => b.trim())
        .filter((b) => b && !b.startsWith("*") && b !== "main");
      for (const b of branches) {
        await exec("git", ["branch", "-d", b], { cwd: ctx.scope.cwd });
      }
      return branches;
    });

    await ctx.artifact.writeJSON("pruned.json", pruned);
    ctx.logger.info(`pruned ${pruned.length} merged branch(es)`);
  },
});
