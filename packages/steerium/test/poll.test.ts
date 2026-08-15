import { strict as assert } from "node:assert";
import { test } from "node:test";
import { pollTrigger } from "../src/triggers/poll.js";
import { delay, fakeTriggerCtx } from "./helpers.js";

const ctx = () => fakeTriggerCtx().ctx;

test("pollTrigger emits each item once and dedupes across ticks", async () => {
  let items = [
    { id: "a", event: { source: "test", id: "a" } },
    { id: "b", event: { source: "test", id: "b" } },
  ];
  const trig = pollTrigger<{ source: string; id: string }>({
    kind: "test.poll",
    intervalMs: 15,
    fetch: async () => items,
  });

  const seen: string[] = [];
  const c = ctx();
  const handle = await trig.start(c, (e) => {
    seen.push(e.id);
  });

  await delay(60); // several ticks; a,b should each emit once
  assert.deepEqual([...seen].sort(), ["a", "b"]);

  // Introduce a new item; only the new one should emit.
  items = [...items, { id: "c", event: { source: "test", id: "c" } }];
  await delay(40);
  await handle.stop();

  assert.deepEqual([...seen].sort(), ["a", "b", "c"]);
  // After stop, no further emits.
  const count = seen.length;
  await delay(40);
  assert.equal(seen.length, count);
});
