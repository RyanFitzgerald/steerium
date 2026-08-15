/** Small helper for the degraded raw-CLI fallback path of agent providers. */
import { execFile } from "node:child_process";

export interface CliResult {
  stdout: string;
  stderr: string;
}

/** Run a CLI, feeding `input` on stdin, returning captured output. */
export function runCli(
  cmd: string,
  args: string[],
  opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        maxBuffer: 64 * 1024 * 1024,
        // execFile sends SIGTERM to the child when the signal aborts, so a run
        // timeout actually kills the agent subprocess.
        signal: opts.signal,
      },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error(`CLI "${cmd}" not found on PATH.`));
            return;
          }
          if ((err as { name?: string }).name === "AbortError") {
            reject(new Error(`${cmd} aborted (run timed out)`));
            return;
          }
          reject(new Error(`${cmd} failed: ${stderr || err.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (opts.input != null && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}
