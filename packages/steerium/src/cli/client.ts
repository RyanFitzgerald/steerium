/**
 * Thin client of the control API. CLI commands use this to talk to a
 * running daemon; if none is reachable they fall back to acting in-process.
 */
import { loadGlobalConfig } from "../config/load.js";

export interface ControlClient {
  base: string;
  token?: string;
}

export async function controlClient(): Promise<ControlClient> {
  const { global } = await loadGlobalConfig();
  const host = global.control?.host ?? "127.0.0.1";
  const port = global.control?.port ?? 4319;
  return { base: `http://${host}:${port}`, token: global.control?.token };
}

/** Returns null if the daemon is not reachable. */
export async function tryRequest<T>(
  client: ControlClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<T | null> {
  try {
    const res = await fetch(client.base + path, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(client.token ? { authorization: `Bearer ${client.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) throw new Error(`control API ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  } catch (err) {
    if (err instanceof Error && /ECONNREFUSED|fetch failed|timeout|aborted/i.test(err.message)) {
      return null;
    }
    // A reachable daemon that returned an error should surface it.
    if (err instanceof Error && /control API \d/.test(err.message)) throw err;
    return null;
  }
}

export async function daemonReachable(client: ControlClient): Promise<boolean> {
  const res = await tryRequest<{ ok: boolean }>(client, "GET", "/health");
  return res?.ok === true;
}
