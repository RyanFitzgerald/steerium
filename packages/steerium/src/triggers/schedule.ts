/** Schedule triggers: cron via `croner`, and a fixed interval. */
import { Cron } from "croner";
import { defineTrigger } from "../define.js";
import type { Trigger, TriggerHandle } from "../types.js";

export interface ScheduleEvent {
  source: "schedule";
  /** ISO timestamp of the firing. */
  firedAt: string;
  /** The cron expression or interval that fired. */
  spec: string;
}

export interface CronOptions {
  tz?: string;
}

function cron(expr: string, opts: CronOptions = {}): Trigger<ScheduleEvent> {
  return defineTrigger<ScheduleEvent>({
    kind: "schedule.cron",
    async start(ctx, emit): Promise<TriggerHandle> {
      const job = new Cron(expr, { timezone: opts.tz }, () => {
        // emit() is invoked *inside* the async wrapper so a synchronous throw
        // becomes a rejection too. Passing it as an argument to
        // Promise.resolve() would let a sync throw escape this callback and
        // take the daemon down as an uncaughtException.
        void (async () =>
          emit({ source: "schedule", firedAt: new Date().toISOString(), spec: expr }))().catch(
          (err) => ctx.logger.error(`cron emit failed: ${String(err)}`),
        );
      });
      ctx.logger.info(`cron scheduled`, { expr, tz: opts.tz, next: job.nextRun()?.toISOString() });
      return { stop: () => job.stop() };
    },
  });
}

function every(ms: number): Trigger<ScheduleEvent> {
  return defineTrigger<ScheduleEvent>({
    kind: "schedule.every",
    async start(ctx, emit): Promise<TriggerHandle> {
      const spec = `every ${ms}ms`;
      const timer = setInterval(() => {
        // See the note in cron(): emit() must be invoked inside the async
        // wrapper so a synchronous throw is caught rather than escaping.
        void (async () =>
          emit({ source: "schedule", firedAt: new Date().toISOString(), spec }))().catch((err) =>
          ctx.logger.error(`interval emit failed: ${String(err)}`),
        );
      }, ms);
      // Don't keep the event loop alive solely for this timer.
      timer.unref?.();
      ctx.logger.info(`interval scheduled`, { ms });
      return { stop: () => clearInterval(timer) };
    },
  });
}

export const schedule = { cron, every };
