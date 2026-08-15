/**
 * Approval-gated publishing, half 1 (pairs with blog-approve.ts). A cron
 * trigger drafts a post daily and asks for approval — then the run ends.
 * Nothing blocks: the pending approval lives in the store (visible at
 * GET /approvals and in the UI) until a reply fires blog-approve.ts, even
 * across daemon restarts.
 *
 * Drop both files into the same workflows directory. As a project workflow
 * the approved post is committed to that repo.
 */
import { defineWorkflow, schedule, approvals } from "steerium";

export default defineWorkflow({
  name: "blog-draft",
  on: schedule.cron("0 9 * * *", { tz: "America/Montreal" }),
  async run(ctx) {
    const date = new Date().toISOString().slice(0, 10);

    const draft = await ctx.step("draft", () =>
      ctx.agent.run({
        provider: "anthropic",
        system: "Concise technical blogger. Markdown only, no preamble.",
        prompt: "Write a 600-word post on one practical software engineering idea.",
      }),
    );
    await ctx.artifact.writeText("draft.md", draft.text);

    // Ask and end. Idempotent while pending: a replayed run doesn't ask twice.
    await ctx.step("ask", () =>
      approvals.request(ctx, {
        id: `blog-${date}`,
        text: `Blog draft for ${date} is ready. Reply "approve" or with feedback.\n\n${draft.text}`,
        options: [{ value: "approve", label: "Approve and publish" }],
        display: { kind: "markdown", title: `Draft for ${date}`, content: draft.text },
        allowFreeform: true,
        payload: { draft: draft.text, date },
        ttlMs: 3 * 24 * 60 * 60_000, // unanswered drafts expire after 3 days
      }),
    );
  },
});
