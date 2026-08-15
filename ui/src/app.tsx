import type { VNode } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { Dashboard } from "./pages/dashboard";
import { Approvals } from "./pages/approvals";
import { Run } from "./pages/run";
import { Runs } from "./pages/runs";
import { Workflow } from "./pages/workflow";
import { Workflows } from "./pages/workflows";
import { Toasts } from "./toast";

/** Hash routing keeps the daemon's static file serving trivial (no rewrites). */
function useRoute(): string[] {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}

function useConnected(): boolean {
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const check = () => api.status().then(() => setConnected(true)).catch(() => setConnected(false));
    check();
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
  }, []);
  return connected;
}

export function App() {
  const route = useRoute();
  const connected = useConnected();
  const section = route[0] ?? "";

  let page: VNode;
  if (section === "workflows" && route[1]) page = <Workflow name={route[1]} />;
  else if (section === "workflows") page = <Workflows />;
  else if (section === "runs" && route[1]) page = <Run id={route[1]} />;
  else if (section === "runs") page = <Runs />;
  else if (section === "approvals") page = <Approvals />;
  else page = <Dashboard />;

  const active = (s: string) => (section === s ? "active" : "");
  return (
    <>
      <header class="top">
        <h1>steerium</h1>
        <nav>
          <a href="#/" class={active("")}>
            dashboard
          </a>
          <a href="#/workflows" class={active("workflows")}>
            workflows
          </a>
          <a href="#/runs" class={active("runs")}>
            runs
          </a>
          <a href="#/approvals" class={active("approvals")}>
            approvals
          </a>
        </nav>
        <span class={`conn ${connected ? "on" : "off"}`}>
          {connected ? "connected" : "daemon unreachable"}
        </span>
      </header>
      <main>{page}</main>
      <Toasts />
    </>
  );
}
