/**
 * Automated code review. Fires when a pull request opens, has a coding agent
 * review the diff from inside the repo checkout, and posts the review back as
 * a PR comment. Project workflow: cwd is the repo, so the agent can read the
 * actual code, not just the diff.
 *
 * Config: connectors.github = { token: { env: "GITHUB_TOKEN" } }
 */
import { defineWorkflow, github } from "steerium";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export default defineWorkflow({
  name: "pr-review",
  on: github.prOpened({ repo: "acme/app", intervalMs: 60_000 }),
  timeoutMs: 15 * 60_000,
  async run(ctx) {
    const { pr } = ctx.event;

    // Deterministic part: fetch the branch so the agent sees the real changes.
    await ctx.step("fetch", async () => {
      await exec("git", ["fetch", "origin", pr.branch], { cwd: ctx.scope.cwd });
    });

    const review = await ctx.step("review", () =>
      ctx.agent.run({
        provider: "claude",
        permissionMode: "default",
        allowedTools: ["Read", "Grep", "Bash"],
        prompt: [
          `Review pull request #${pr.number} ("${pr.title}") on branch ${pr.branch}.`,
          `Diff it against ${pr.baseBranch} (git diff ${pr.baseBranch}...origin/${pr.branch}).`,
          "Focus on correctness bugs and risky changes; skip style nits.",
          "Reply as a markdown review comment.",
        ].join("\n"),
      }),
    );

    await ctx.step("comment", async () => {
      const { token } = ctx.connector<{ token: string }>("github");
      await github.comment(token, pr.repo, pr.number, review.text);
    });

    await ctx.artifact.writeText("review.md", review.text);
  },
});
