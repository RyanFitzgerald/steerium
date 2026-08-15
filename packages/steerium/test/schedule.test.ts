import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ScheduleEvent } from "../src/triggers/schedule.js";
import { schedule } from "../src/triggers/schedule.js";
import { delay, fakeTriggerCtx, waitFor } from "./helpers.js";

test("schedule.every emits on its interval and stops cleanly", async () => {
  const { ctx } = fakeTriggerCtx();
  const trig = schedule.every(20);
  assert.equal(trig.kind, "schedule.every");

  const events: ScheduleEvent[] = [];
  const handle = await trig.start(ctx, (e) => void events.push(e));
  await waitFor(() => events.length >= 2, { message: "two interval firings" });

  assert.equal(events[0]!.source, "schedule");
  assert.equal(events[0]!.spec, "every 20ms");
  assert.ok(!Number.isNaN(Date.parse(events[0]!.firedAt)), "firedAt must be an ISO timestamp");

  await handle.stop();
  const settled = events.length;
  await delay(80);
  assert.equal(events.length, settled, "no emits after stop");
});

test("schedule.cron fires on a per-second expression and stops cleanly", async () => {
  const { ctx } = fakeTriggerCtx();
  const trig = schedule.cron("* * * * * *"); // six fields: every second
  assert.equal(trig.kind, "schedule.cron");

  const events: ScheduleEvent[] = [];
  const handle = await trig.start(ctx, (e) => void events.push(e));
  await waitFor(() => events.length >= 1, {
    timeoutMs: 4000,
    message: "one cron firing",
  });
  assert.equal(events[0]!.spec, "* * * * * *");
  assert.equal(events[0]!.source, "schedule");

  await handle.stop();
  const settled = events.length;
  await delay(1200);
  assert.equal(events.length, settled, "a stopped cron job must not fire again");
});

test("cron logs the next run time at startup", async () => {
  const { ctx, logger } = fakeTriggerCtx();
  const handle = await schedule.cron("0 14 * * *", { tz: "America/Montreal" }).start(ctx, () => {});
  assert.ok(
    logger.lines.some((l) => l.includes("cron scheduled")),
    "operators need to see the schedule was accepted",
  );
  await handle.stop();
});

test("an invalid cron expression fails at start, not silently at fire time", async () => {
  const { ctx } = fakeTriggerCtx();
  await assert.rejects(schedule.cron("not a cron expression").start(ctx, () => {}));
});

test("an emit that rejects is logged, not left as an unhandled rejection", async () => {
  const { ctx, logger } = fakeTriggerCtx();
  const handle = await schedule.every(15).start(ctx, () => {
    throw new Error("downstream exploded");
  });
  await waitFor(() => logger.lines.some((l) => l.includes("downstream exploded")), {
    message: "the emit failure to be logged",
  });
  await handle.stop();
});
