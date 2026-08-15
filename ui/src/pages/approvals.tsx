import { useEffect, useState } from "preact/hooks";
import { api, type ApprovalListing } from "../api";
import { StatusBadge } from "../components";
import { toast } from "../toast";

function ApprovalDisplay({ item }: { item: ApprovalListing }) {
  const display = item.approval.display;
  if (!display) return null;
  if (display.kind === "link") {
    return <p><a href={display.content} target="_blank" rel="noreferrer">{display.title ?? display.content}</a></p>;
  }
  return (
    <details open>
      <summary>{display.title ?? display.kind}</summary>
      <pre>{display.content}</pre>
    </details>
  );
}

export function Approvals() {
  const [items, setItems] = useState<ApprovalListing[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const refresh = () => api.approvals().then(setItems).catch(() => setItems([]));

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  const respond = (item: ApprovalListing, text: string) => {
    if (!text.trim()) return;
    api.respondApproval(
      item.approval.id,
      text.trim(),
      item.approval.requestId,
      item.scopeId,
    ).then(() => {
      toast(`answered ${item.approval.id}`, "ok");
      setDrafts((current) => ({
        ...current,
        [`${item.scopeId}:${item.approval.id}`]: "",
      }));
      refresh();
    }).catch((error: Error) => toast(error.message, "error"));
  };

  return (
    <>
      <h2>Approvals</h2>
      {!items.length && <div class="empty">no approvals</div>}
      <div class="approval-list">
        {items.map((item) => {
          const approval = item.approval;
          const pending = approval.status === "pending";
          const draftKey = `${item.scopeId}:${approval.id}`;
          return (
            <section class="approval" key={`${item.scopeId}:${approval.id}`}>
              <div class="controls">
                <strong>{approval.id}</strong>
                <StatusBadge status={approval.status} />
                <span class="muted">round {approval.rounds} · {item.scopeId}</span>
              </div>
              <p>{approval.text}</p>
              <ApprovalDisplay item={item} />
              {pending && approval.options?.length ? (
                <div class="controls">
                  {approval.options.map((option) => (
                    <button type="button" class="primary" key={option.value} title={option.description} onClick={() => respond(item, option.value)}>
                      {option.label ?? option.value}
                    </button>
                  ))}
                </div>
              ) : null}
              {pending && approval.allowFreeform && (
                <div class="controls">
                  <input
                    class="approval-reply"
                    aria-label={`Reply to ${approval.id}`}
                    placeholder="reply…"
                    value={drafts[draftKey] ?? ""}
                    onInput={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [draftKey]: event.currentTarget.value,
                      }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") respond(item, drafts[draftKey] ?? "");
                    }}
                  />
                  <button type="button" onClick={() => respond(item, drafts[draftKey] ?? "")}>
                    send
                  </button>
                </div>
              )}
              {approval.replies.length > 0 && (
                <p class="muted">{approval.replies.length} repl{approval.replies.length === 1 ? "y" : "ies"}</p>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
