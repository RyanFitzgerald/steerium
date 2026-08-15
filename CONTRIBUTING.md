# Contributing to steerium

Thanks for your interest! steerium is young and deliberately small — the
fastest way to get a change in is to keep it scoped and grounded in a real use
case.

## Development setup

Node **>= 22.13** is required (built-in `node:sqlite`).

This is an npm-workspaces monorepo: the published package lives in
[packages/steerium](./packages/steerium), the browser UI in [ui](./ui), and
the docs site in [apps/docs](./apps/docs).

```bash
git clone https://github.com/RyanFitzgerald/steerium.git
cd steerium
npm install            # installs all workspaces
npm run build          # compile the package to packages/steerium/dist/
npm test               # node:test suite (build first — workflows resolve the built package)
npm run typecheck      # tsc --noEmit
npm run lint           # biome lint
npm run test:coverage  # node:test with coverage thresholds
npm run build:ui       # build the browser UI into packages/steerium/dist/ui
npm run docs:dev       # docs site dev server
```

Run the CLI straight from source while developing:

```bash
npm run steerium -- workflow list
```

Tests create isolated `STEERIUM_HOME` directories under the OS temp dir, so
they never touch your real `~/.steerium`.

## Tests

The suite is plain `node:test` run through `tsx` — no Jest, no Vitest, no
config file. Build first: workflow fixtures `import "steerium"`, which resolves
to `packages/steerium/dist/`, and the CLI tests spawn `dist/cli/index.js`.

Shared scaffolding lives in
[test/helpers.ts](./packages/steerium/test/helpers.ts): `freshHome()`,
`newDaemon()`, `stubServer()`, `withFetch()`, `waitFor()` and friends. Reach for
those instead of hand-rolling a temp dir or a context stub — every path they
create is cleaned up when the process exits.

Two things to know before adding a file:

- **`freshHome()` mutates `process.env.STEERIUM_HOME`.** node:test runs one
  process per file and tests sequentially within a file, which is what keeps
  that safe. Do not make a file that calls it concurrent.
- **Prefer `waitFor()` over a fixed sleep.** It returns as soon as the
  condition holds and fails loudly with a message when it never does.

Coverage is measured, not just collected:

```bash
npm run test:coverage   # fails under 90% lines / 80% branches / 80% functions
```

The thresholds cover `packages/steerium/src`. Two known gaps sit below the
line and are excluded from the argument by design:

- `src/providers/claude.ts` and `src/providers/codex.ts` drive external agent
  SDKs; only their pure helpers are reachable without those binaries.
- `src/cli/index.ts` is exercised end-to-end by
  [test/cli.test.ts](./packages/steerium/test/cli.test.ts), which spawns it as a
  subprocess — so its coverage is real but not counted in this process.

## Linting

`npm run lint` runs Biome (lint only — the **formatter is off**, since turning
it on would rewrite every file). Four recommended rules are disabled in
[biome.json](./biome.json) because they fight idioms this codebase uses on
purpose:

| Rule | Why it's off |
| --- | --- |
| `style/noNonNullAssertion` | `noUncheckedIndexedAccess` is on, so `arr[0]!` is how you index a known-populated array. |
| `complexity/useLiteralKeys` | `payload["type"]` on `Record<string, unknown>` reads as "this is untyped data". |
| `suspicious/noConfusingVoidType` | `void` is correct in `Promisable<void>` and trigger emit signatures. |
| `correctness/noVoidTypeReturn` | `return err("usage: ...")` is the CLI's early-exit idiom. |

Note that `biome.json` must stay **comment-free**: Biome silently ignores a
config it cannot parse, so a stray `//` turns every rule back on without
reporting an error.

## Before you open a PR

- `npm test`, `npm run typecheck`, and `npm run lint` must pass.
- New behavior needs a test. The existing suites
  ([test/daemon.test.ts](./packages/steerium/test/daemon.test.ts),
  [test/github.test.ts](./packages/steerium/test/github.test.ts)) show the patterns: daemon tests
  drive real workflows through a temp home; connector tests exercise webhook
  handlers with a stubbed `TriggerContext`, no network.
- Match the existing style: small modules, a doc comment at the top of each
  module saying what it is and why, no new runtime dependencies without prior
  discussion in an issue.

## Adding a connector

Connectors are the most wanted contribution. They're built entirely on the
public API — no internal access needed:

1. Copy [src/connectors/linear.ts](./packages/steerium/src/connectors/linear.ts)
   (~170 lines) as the template;
   [github.ts](./packages/steerium/src/connectors/github.ts) shows the same pattern
   with REST + label filtering.
2. Support **poll mode** (via `pollTrigger`, dedup cursor included) and, where
   the service offers it, **webhook mode** with signature verification that
   **fails closed** when no secret is configured.
3. Emit a normalized event with a stable `dedupeKey`, attach the raw payload
   under `raw`, and read secrets via `ctx.connector("<name>")`.
4. Export it from [src/index.ts](./packages/steerium/src/index.ts) and add a
   webhook-handler test.

Note that a connector doesn't have to live in this repo — the `define*` API is
public precisely so third-party packages work. We bundle a small reference set
(Linear, Jira, GitHub) and prefer new integrations as separate packages unless
they're clearly universal.

## Adding a provider

Implement the `Provider` interface (see
[src/providers/mock.ts](./packages/steerium/src/providers/mock.ts)
for the minimal shape) and register it under `providers` in config. Optional
SDKs must be loaded lazily so the core keeps installing without them, and a
`health()` probe makes `steerium doctor` useful.

## Questions

Open a [GitHub issue](https://github.com/RyanFitzgerald/steerium/issues) — for
security reports, see [SECURITY.md](./SECURITY.md) instead.
