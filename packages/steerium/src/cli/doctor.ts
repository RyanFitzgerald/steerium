/**
 * `steerium doctor`: a single read-only health command. Reports
 * Node version, which auth method each provider resolved to, and connector
 * config presence. Never mutates anything.
 */
import { createLogger } from "../logger.js";
import { ProviderRegistry } from "../providers/registry.js";
import { globalScope } from "../scope.js";
import { loadGlobalConfig } from "../config/load.js";

export interface DoctorLine {
  ok: boolean;
  label: string;
  detail: string;
}

function checkNode(): DoctorLine {
  const [major, minor] = process.versions.node.split(".").map(Number);
  const ok = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 13);
  return {
    ok,
    label: `Node ${process.versions.node}`,
    detail: ok ? ">= 22.13 (node:sqlite available)" : "steerium needs Node >= 22.13",
  };
}

export async function runDoctor(): Promise<{ lines: DoctorLine[]; ok: boolean }> {
  const lines: DoctorLine[] = [checkNode()];
  const { global } = await loadGlobalConfig();
  const registry = new ProviderRegistry(global);
  const logger = createLogger({ level: "error" });
  const scope = globalScope();

  for (const name of registry.list()) {
    const provider = registry.get(name);
    if (!provider.health) {
      lines.push({ ok: true, label: `provider ${name}`, detail: "no health probe" });
      continue;
    }
    try {
      const h = await provider.health({ scope, logger, config: registry.configFor(name) });
      lines.push({ ok: h.ok, label: `provider ${name}`, detail: `${h.auth}${h.detail ? ` — ${h.detail}` : ""}` });
    } catch (err) {
      lines.push({ ok: false, label: `provider ${name}`, detail: String(err) });
    }
  }

  for (const [name, settings] of Object.entries(global.connectors ?? {})) {
    const keys = Object.keys(settings);
    lines.push({
      ok: keys.length > 0,
      label: `connector ${name}`,
      detail: keys.length ? `configured: ${keys.join(", ")}` : "no settings",
    });
  }

  const ok = lines.every((l) => l.ok);
  return { lines, ok };
}
