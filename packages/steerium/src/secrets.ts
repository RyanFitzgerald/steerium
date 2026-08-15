/** Secret resolution from env references. No keychain yet. */
import { registerSecret } from "./logger.js";
import type { Secret } from "./types.js";

/** Resolve a Secret (string or { env }) to its value, or undefined. */
export function resolveSecret(secret: Secret | undefined): string | undefined {
  if (secret == null) return undefined;
  let value: string | undefined;
  if (typeof secret === "string") value = secret;
  else if (typeof secret === "object" && "env" in secret) value = process.env[secret.env];
  registerSecret(value);
  return value;
}

/** Resolve, falling back to a named env var if no explicit secret is set. */
export function resolveSecretOrEnv(secret: Secret | undefined, envVar: string): string | undefined {
  const explicit = resolveSecret(secret);
  if (explicit) return explicit;
  const fromEnv = process.env[envVar];
  registerSecret(fromEnv);
  return fromEnv;
}
