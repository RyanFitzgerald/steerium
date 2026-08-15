/**
 * Scheduled content generation. A cron trigger fires daily; the workflow
 * drafts a post and writes it into the scope's working directory. Global
 * workflow → posts land under ~/.steerium; project workflow → in the repo.
 */
import { defineWorkflow, schedule } from "steerium";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export default defineWorkflow({
  name: "daily-content",
  on: schedule.cron("0 14 * * *", { tz: "America/Montreal" }),
  async run(ctx) {
    const post = await ctx.step("write", () =>
      ctx.agent.run({
        provider: "anthropic",
        system: "Concise technical blogger. Markdown only, no preamble.",
        prompt: "Write a 600-word post on one practical software engineering idea.",
      }),
    );

    const title = post.text.split("\n")[0]?.replace(/^#+\s*/, "").slice(0, 60) ?? "post";
    await ctx.step("save", async () => {
      const dir = join(ctx.scope.cwd, "posts");
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString().slice(0, 10)}.md`);
      await writeFile(file, post.text);
      ctx.logger.info(`wrote ${file} (${title})`);
    });

    await ctx.artifact.writeText("post.md", post.text);
  },
});
