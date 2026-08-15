/**
 * Tiny structured logger with secret redaction. Writes
 * human-readable lines to stderr and, when given a sink, mirrors them so
 * step logs can be captured into the store.
 */
import type { Logger } from "./types.js";

export type LogSink = (line: string) => void;

const SECRET_PATTERNS: RegExp[] = [
  // Common API-key shapes; redact the value, keep the prefix for debugging.
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(lin_api_[A-Za-z0-9_-]{8,})\b/g,
  /\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
  /\b(ghp_[A-Za-z0-9]{8,})\b/g,
];

/** Registry of literal secret values to scrub from any log line. */
const knownSecrets = new Set<string>();

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) knownSecrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of knownSecrets) {
    out = out.split(secret).join("«redacted»");
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, p1: string) => `${p1.slice(0, 6)}…«redacted»`);
  }
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function envLevel(): Level {
  const v = (process.env.STEERIUM_LOG_LEVEL ?? "info").toLowerCase();
  return (v in LEVELS ? v : "info") as Level;
}

export interface CreateLoggerOptions {
  bindings?: Record<string, unknown>;
  sink?: LogSink;
  level?: Level;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const bindings = opts.bindings ?? {};
  const threshold = LEVELS[opts.level ?? envLevel()];

  function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < threshold) return;
    const prefix = Object.entries(bindings)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    const line = redact(
      `${new Date().toISOString()} ${level.toUpperCase()} ${prefix ? `${prefix} ` : ""}${msg}${metaStr}`,
    );
    // Diagnostics always go to stderr so stdout stays clean for command output.
    process.stderr.write(`${line}\n`);
    opts.sink?.(line);
  }

  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
    child: (extra) =>
      createLogger({ ...opts, bindings: { ...bindings, ...extra } }),
  };
}
