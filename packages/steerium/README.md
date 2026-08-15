# steerium

**A local-first TypeScript workflow orchestrator for deterministic code, AI
calls, and coding agents.**

steerium runs ordinary TypeScript files when a trigger fires: cron schedules,
manual runs, tickets, GitHub issues or PRs, and signature-verified webhooks. A
workflow is just an async function, so it can be deterministic, agent-driven,
or both: run Node logic, shell out to git or npm, call OpenAI or Anthropic, or
drive Codex or Claude inside the target repo.

steerium is built for developer workflows that need to live with your code:
*prune merged branches every morning. Draft the changelog every Friday. Review
every PR when it opens. When a ticket moves to Todo, have an agent take a first
pass.* Each workflow is one file:

```ts
// ~/code/my-app/.steerium/workflows/implement.ts
import { defineWorkflow, linear } from "steerium";

export default defineWorkflow({
  name: "implement",
  on: linear.ticketMoved({ to: "Todo" }),   // the trigger lives with the handler
  timeoutMs: 45 * 60_000,
  async run(ctx) {
    const { ticket } = ctx.event;

    const plan = await ctx.step("plan", () =>
      ctx.agent.run({ provider: "openai", prompt: `Plan ${ticket.identifier}: ${ticket.title}` }),
    );

    await ctx.step("implement", () =>
      ctx.agent.run({
        provider: "claude",                 // a real coding agent, in this repo
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Edit", "Bash"],
        prompt: `Implement this plan:\n\n${plan.text}`,
      }),
    );

    await ctx.artifact.writeText("plan.md", plan.text);
  },
});
```

- **Deterministic, AI, or both** — plain async TypeScript functions. Use fs,
  git, shell commands, APIs, and any npm package; call AI providers or coding
  agents only when the workflow needs them. No DSL, no YAML.
- **One trigger abstraction** — cron, intervals, Linear/Jira/GitHub events
  (poll or signature-verified webhook), manual fires. Custom triggers are
  first-class.
- **Providers, chosen per call** — OpenAI and Anthropic by API key, or Codex
  and Claude as real coding agents (on a laptop, via your existing CLI
  subscription).
- **Every run is a record** — events, per-step status and logs, and artifacts
  persist in SQLite; `replay` re-runs any workflow against its exact event.
- **Human-in-the-loop approvals** — `approvals.request` asks a question and
  the run ends; a second workflow fires on each reply. Answer over the
  control API/UI or a Slack-style transport; pending approvals survive
  restarts because they live in the store, not a blocked process.
- **Local-first, self-hosted** — a single daemon with a localhost control API,
  a CLI, and a browser UI. No hosted platform in between.

## Install

Requires Node **>= 22.13**.

```bash
npm install -g steerium
```

## Quick start

No API keys needed — the default `mock` provider is deterministic:

```bash
steerium init                 # scaffold ~/.steerium + starter workflows
steerium workflow run hello   # fire a workflow once
steerium logs                 # every run is recorded
steerium start                # run the daemon: triggers, control API, browser UI
```

With the daemon running, open **http://127.0.0.1:4319/** for the browser UI:
a dashboard, workflow pages with a fire-with-input form, filterable run
history updating live, and per-run detail with step logs, downloadable
artifacts, cancel, and replay.

## CLI at a glance

```
steerium init | start | status | doctor
steerium project add|list|remove <path>
steerium workflow list | run <name> [--input <json>]
steerium logs [--follow]
steerium run <runId> | replay <runId> | cancel <runId>
steerium config export | import <file>
```

## Documentation

- **Full documentation** — the
  [README on GitHub](https://github.com/RyanFitzgerald/steerium#readme):
  triggers, providers, projects & scopes, the workflow context, runtime
  guarantees, the control API, and the security model.
- **Examples** —
  [copy-pasteable workflows](https://github.com/RyanFitzgerald/steerium/tree/main/packages/steerium/examples):
  PR review, ticket → coding agent, scheduled content, approval-gated
  publishing, repo housekeeping.
- **Contributing** —
  [CONTRIBUTING.md](https://github.com/RyanFitzgerald/steerium/blob/main/CONTRIBUTING.md);
  connectors are the most wanted contribution.

## License

[MIT](./LICENSE)
