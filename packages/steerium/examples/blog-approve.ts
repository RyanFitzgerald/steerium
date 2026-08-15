/**
 * Approval-gated publishing, half 2 (pairs with blog-draft.ts). Fires once
 * per human reply to a pending approval. Approve → the post is committed and
 * pushed; feedback → the draft is revised and re-asked. Each round is just
 * another event, so the revision loop needs no loop construct.
 *
 * Reply over the control API (the UI does the same thing):
 *
 *   curl -X POST http://127.0.0.1:4319/approvals/blog-2026-07-08/respond \
 *     -d '{"text": "approve"}'
 *
 * Or pass an ApprovalTransport (e.g. Slack) to both approvals.request and
 * approvals.responded to ask and answer in a thread instead.
 */
import { defineWorkflow, approvals, isApprove } from "steerium";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

interface BlogPayload {
  draft: string;
  date: string;
}

export default defineWorkflow({
  name: "blog-approve",
  on: approvals.responded<BlogPayload>(),
  async run(ctx) {
    const { type, approval, reply } = ctx.event;
    // The responded() trigger sees every approval in this scope; claim only ours.
    if (!approval.id.startsWith("blog-")) return;
    if (type === "expired") {
      ctx.logger.warn(`draft ${approval.id} expired unanswered`);
      return;
    }

    if (isApprove(reply!.text)) {
      await ctx.step("publish", async () => {
        const dir = join(ctx.scope.cwd, "posts");
        await mkdir(dir, { recursive: true });
        const file = join(dir, `${approval.payload.date}.md`);
        await writeFile(file, approval.payload.draft);
        const git = (...args: string[]) =>
          exec("git", args, { cwd: ctx.scope.cwd, signal: ctx.signal });
        await git("add", file);
        await git("commit", "-m", `post: ${approval.payload.date}`);
        await git("push");
      });
      await approvals.resolve(ctx, approval.id);
    } else {
      const revised = await ctx.step("revise", () =>
        ctx.agent.run({
          provider: "anthropic",
          system: "Concise technical blogger. Markdown only, no preamble.",
          prompt: `Revise this draft per the feedback.\n\nFeedback: ${reply!.text}\n\nDraft:\n\n${approval.payload.draft}`,
        }),
      );
      await ctx.artifact.writeText("revised.md", revised.text);
      await approvals.reask(ctx, {
        id: approval.id,
        text: `Revised draft for ${approval.payload.date}. Reply "approve" or with more feedback.\n\n${revised.text}`,
        payload: { ...approval.payload, draft: revised.text }, // next round builds on this
      });
    }
  },
});
