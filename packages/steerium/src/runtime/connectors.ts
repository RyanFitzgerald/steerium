/**
 * Resolve connector config for ctx.connector(name). Any `{ env: "X" }`
 * value is resolved from the environment and registered for log redaction.
 */
import { registerSecret } from "../logger.js";
import type { SteeriumConfig } from "../types.js";

function resolveValue(v: unknown): unknown {
  if (v && typeof v === "object" && "env" in (v as Record<string, unknown>)) {
    const name = (v as { env: string }).env;
    const val = process.env[name];
    registerSecret(val);
    return val;
  }
  return v;
}

export function resolveConnectorConfig(
  config: SteeriumConfig,
  name: string,
): Record<string, unknown> {
  const raw = config.connectors?.[name] ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = resolveValue(v);
  }
  return out;
}

export function makeConnectorResolver(config: SteeriumConfig) {
  const cache = new Map<string, Record<string, unknown>>();
  return function connector<T = Record<string, unknown>>(name: string): T {
    if (!cache.has(name)) cache.set(name, resolveConnectorConfig(config, name));
    return cache.get(name) as T;
  };
}
