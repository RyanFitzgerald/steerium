import { useEffect, useState } from "preact/hooks";

export type ToastKind = "ok" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

type Listener = (items: ToastItem[]) => void;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l(items);
}

export function toast(message: string, kind: ToastKind = "info"): void {
  const item = { id: nextId++, message, kind };
  items = [...items, item];
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== item.id);
    emit();
  }, 6000);
}

export function Toasts() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return (
    <div id="toasts">
      {list.map((t) => (
        <div key={t.id} class={`toast ${t.kind === "info" ? "" : t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
