import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// In dev, vite serves the SPA and proxies API calls to a running daemon
// (`steerium start`, default port 4319). In production the daemon itself
// serves the built files from dist/ui, so paths must stay relative.
const DAEMON = process.env.STEERIUM_CONTROL_URL ?? "http://127.0.0.1:4319";

export default defineConfig({
  plugins: [preact()],
  base: "./",
  server: {
    proxy: Object.fromEntries(
      ["/workflows", "/runs", "/run", "/replay", "/status", "/health", "/stream"].map((p) => [
        p,
        { target: DAEMON, changeOrigin: true },
      ]),
    ),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
