/** Per-run artifact writer. Files live under artifacts/<runId>/. */
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { atomicWriteFile } from "../atomic-write.js";
import type { ArtifactWriter } from "../types.js";

export type ArtifactObserver = (artifact: {
  name: string;
  path: string;
  kind: "text" | "json" | "bytes";
}) => void;

export function createArtifactWriter(dir: string, observe?: ArtifactObserver): ArtifactWriter {
  const root = resolve(dir);

  /** Resolve a name inside the run dir (subdirs allowed, escaping it is not). */
  async function target(name: string): Promise<string> {
    const path = resolve(root, name);
    if (!path.startsWith(root + sep)) {
      throw new Error(`artifact name escapes the run directory: ${name}`);
    }
    await mkdir(dirname(path), { recursive: true });
    return path;
  }

  return {
    dir,
    async writeText(name, content) {
      const path = await target(name);
      await atomicWriteFile(path, content);
      observe?.({ name, path, kind: "text" });
      return path;
    },
    async writeJSON(name, value) {
      const path = await target(name);
      await atomicWriteFile(path, JSON.stringify(value, null, 2));
      observe?.({ name, path, kind: "json" });
      return path;
    },
    async writeBytes(name, bytes) {
      const path = await target(name);
      await atomicWriteFile(path, bytes);
      observe?.({ name, path, kind: "bytes" });
      return path;
    },
  };
}
