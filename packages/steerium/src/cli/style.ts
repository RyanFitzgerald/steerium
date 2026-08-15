/**
 * Zero-dependency ANSI styling for CLI output. Colors turn off when
 * stdout is not a TTY or NO_COLOR is set; FORCE_COLOR turns them back on.
 * Everything degrades to plain readable text.
 */
import { homedir } from "node:os";

const colorEnabled =
  process.env.NO_COLOR === undefined &&
  (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY === true);

function style(open: number, close: number): (text: string) => string {
  return (text) => (colorEnabled ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

export const bold = style(1, 22);
export const dim = style(2, 22);
export const red = style(31, 39);
export const green = style(32, 39);
export const yellow = style(33, 39);
export const cyan = style(36, 39);

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the ESC control character is precisely what an ANSI escape stripper does.
const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Remove ANSI styling while preserving the visible text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** Visible width of a string, ignoring ANSI escapes. */
export function width(text: string): number {
  return stripAnsi(text).length;
}

/** padEnd that measures visible width, so colored cells align. */
export function pad(text: string, target: number): string {
  const missing = target - width(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

/** Shorten a path by replacing the home directory with ~. */
export function tildify(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Color a run/step status word by outcome. */
export function statusColor(status: string): string {
  const s = status.trim().toLowerCase();
  if (s === "success" || s === "ok") return green(status);
  if (["error", "failed", "cancelled", "timed_out", "interrupted", "dropped"].includes(s)) {
    return red(status);
  }
  if (s === "queued" || s === "running") return yellow(status);
  return dim(status);
}

/** "3m 12s" style duration for uptime displays. */
export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
