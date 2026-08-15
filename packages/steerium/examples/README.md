# Example workflows

Copy-pasteable workflows for the main steerium use cases. Each file is a
complete, working workflow — drop it into a workflows directory and it loads:

- **Global** (runs with `cwd = ~/.steerium`): copy into `~/.steerium/workflows/`
- **Project** (runs with `cwd = the repo`): copy into `<repo>/.steerium/workflows/`

| Example | Trigger | Providers | Use case |
|---|---|---|---|
| [daily-content.ts](./daily-content.ts) | cron | anthropic | scheduled content generation |
| [blog-draft.ts](./blog-draft.ts) + [blog-approve.ts](./blog-approve.ts) | cron + approval reply | anthropic | draft daily, publish (commit + push) on human approval, revise on feedback |
| [pr-review.ts](./pr-review.ts) | GitHub PR opened | claude (agent) | automated code review, posted back to the PR |
| [ticket-agent.ts](./ticket-agent.ts) | Linear ticket moved | openai + codex | spawn a coding agent per ticket |
| [repo-housekeeping.ts](./repo-housekeeping.ts) | interval | none | deterministic-only workflow (no AI) |
| [structured-triage.ts](./structured-triage.ts) | manual | openai | typed JSON Schema output via `AgentResult<T>.data` |

Examples without structured output work with `provider: "mock"` if you want
to try the wiring before adding credentials. Structured output requires
OpenAI, Anthropic, Codex, Claude, or a custom provider that explicitly opts in.

Connector credentials go in config, referenced from the environment:

```ts
// ~/.steerium/config.ts (or <repo>/.steerium/config.ts — project wins)
import { defineConfig } from "steerium";

export default defineConfig({
  providers: { anthropic: { apiKey: { env: "ANTHROPIC_API_KEY" } } },
  connectors: {
    github: { token: { env: "GITHUB_TOKEN" } },
    linear: { apiKey: { env: "LINEAR_API_KEY" } },
  },
});
```
