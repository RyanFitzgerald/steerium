import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Scope, SteeriumConfig, WorkflowProvenance } from "../types.js";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const SECRET_KEY = /(api[-_]?key|token|secret|password|authorization|credential)/i;

function safeConfig(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "function") return `[function:${value.name || "anonymous"}]`;
  if (Array.isArray(value)) return value.map((item) => safeConfig(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, item]) => [
        childKey,
        safeConfig(item, childKey),
      ]),
    );
  }
  return value;
}

/** Hash only runtime-affecting, non-secret config metadata. */
export function configFingerprint(config: SteeriumConfig): string {
  return hash(
    stable({
      providers: safeConfig(config.providers ?? {}),
      connectors: safeConfig(config.connectors ?? {}),
      defaults: safeConfig(config.defaults),
      control: {
        host: config.control?.host,
        port: config.control?.port,
        ui: config.control?.ui,
        maxBodyBytes: config.control?.maxBodyBytes,
      },
    }),
  );
}

function gitIdentity(cwd: string): WorkflowProvenance["git"] | undefined {
  try {
    const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain=v1"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { sha, dirty: status.length > 0 };
  } catch {
    return undefined;
  }
}

export function buildWorkflowProvenance(
  file: string | undefined,
  scope: Scope,
  config: SteeriumConfig,
  workflowName: string,
): WorkflowProvenance {
  const workflowFile = file ?? "<inline>";
  const source = file && existsSync(file) ? readFileSync(file, "utf8") : workflowName;
  return {
    steeriumVersion: packageJson.version,
    nodeVersion: process.version,
    workflowFile,
    workflowHash: hash(source),
    configFingerprint: configFingerprint(config),
    git: gitIdentity(scope.projectRoot ?? (file ? dirname(file) : scope.cwd)),
  };
}
