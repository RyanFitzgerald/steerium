/**
 * Ticket → coding agent. When a Linear issue moves to Todo, plan with a cheap
 * API call, then let a coding agent implement it on a branch in the repo.
 * Project workflow: cwd is the repo root. Jira is the same shape —
 * `jira.issueTransitioned({ to: "To Do" })` with ctx.event.ticket.
 *
 * Config: connectors.linear = { apiKey: { env: "LINEAR_API_KEY" } }
 */
import { defineWorkflow, linear } from "steerium";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export default defineWorkflow({
  name: "ticket-agent",
  on: linear.ticketMoved({ to: "Todo", intervalMs: 60_000 }),
  concurrency: 1, // one agent in the repo at a time; extra tickets queue
  timeoutMs: 45 * 60_000,
  async run(ctx) {
    const { ticket } = ctx.event;
    const branch = `steerium/${ticket.identifier.toLowerCase()}`;

    const plan = await ctx.step("plan", () =>
      ctx.agent.run({
        provider: "openai",
        prompt: `Draft a short implementation plan for ${ticket.identifier}: ${ticket.title}\n\n${ticket.description}`,
      }),
    );

    await ctx.step("branch", async () => {
      await exec("git", ["checkout", "-B", branch], { cwd: ctx.scope.cwd });
    });

    await ctx.step("implement", () =>
      ctx.agent.run({
        provider: "codex", // or "claude" — chosen per call
        prompt: `Implement this plan in the repo, then run the test suite:\n\n${plan.text}`,
      }),
    );

    await ctx.artifact.writeText("plan.md", plan.text);

    // Close the loop: tell the ticket what happened.
    const { apiKey } = ctx.connector<{ apiKey: string }>("linear");
    await ctx.step("report", () =>
      linear.comment(apiKey, ticket.id, `Agent run complete on \`${branch}\`.\n\n${plan.text}`),
    );
  },
});
