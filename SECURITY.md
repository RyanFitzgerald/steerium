# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Preferred: [GitHub private vulnerability reporting](https://github.com/RyanFitzgerald/steerium/security/advisories/new)
- Or email: **me@ryanfitzgerald.ca**

You'll get an acknowledgement within a few days. Please include reproduction
steps and the commit or version you tested.

## Threat model (what is and isn't a vulnerability)

steerium is a local-first developer tool with an explicit trust posture
(see "Security model" in the README). Reports are most useful when they
target the boundaries the design *does* promise:

**In scope — we want to hear about these:**

- Control API reachable from non-local hosts without the configured token, or
  token checks that can be bypassed.
- Webhook signature verification bypasses (Linear, Jira, GitHub), or connectors
  accepting unsigned payloads when a secret is configured.
- Secrets leaking into logs, run/step records, artifacts, or API responses
  despite redaction.
- Path traversal out of a run's artifact directory.
- A registered project's workflow gaining access it shouldn't have *by
  steerium's own mechanisms* (e.g. another project's connector secrets).

**Out of scope — by design, not a bug:**

- Workflows executing arbitrary code with the daemon user's OS privileges.
  Workflows are trusted code; `steerium project add` is the trust boundary,
  the same as running `make` or a git hook.
- Anything an attacker can do only after achieving local code execution as
  the same user.
- Coding-agent behavior governed by the agent SDK's own `permissionMode` /
  `allowedTools` — constrain agents through those knobs; issues in the SDKs
  belong upstream.

## Supported versions

Pre-1.0, only the latest release (and `main`) receives security fixes.
