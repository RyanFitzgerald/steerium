/**
 * Reusable poll trigger. Queries on an interval, emits one event per
 * newly seen item, and records seen ids in the trigger's persistent state so
 * the same item never fires twice (the dedup cursor). Connectors build their
 * poll triggers on top of this.
 */
import { defineTrigger } from "../define.js";
import type { Trigger, TriggerContext, TriggerHandle } from "../types.js";

export interface PollDefinition<E> {
  kind: string;
  intervalMs: number;
  /** Fetch the current candidate items from the external system. */
  fetch(ctx: TriggerContext): Promise<PollItem<E>[]>;
  /** Namespace for the seen-id set in trigger state. */
  stateKey?: string;
  /** Cap on remembered ids to bound state growth. Default 5000. */
  maxRemembered?: number;
}

export interface PollItem<E> {
  /** Stable id used for dedup. */
  id: string;
  event: E;
}

export function pollTrigger<E>(def: PollDefinition<E>): Trigger<E> {
  const stateKey = def.stateKey ?? "seen";
  const maxRemembered = def.maxRemembered ?? 5000;

  return defineTrigger<E>({
    kind: def.kind,
    async start(ctx, emit): Promise<TriggerHandle> {
      let stopped = false;

      const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
          const items = await def.fetch(ctx);
          const seen = ((await ctx.state.get<string[]>(stateKey)) ?? []) as string[];
          const seenSet = new Set(seen);
          const fresh = items.filter((it) => !seenSet.has(it.id));

          for (const it of fresh) {
            await emit(it.event);
            seenSet.add(it.id);
          }

          if (fresh.length > 0) {
            // Keep the most recent ids, bounded.
            const next = [...seenSet].slice(-maxRemembered);
            await ctx.state.set(stateKey, next);
            ctx.logger.info(`${def.kind}: emitted ${fresh.length} new event(s)`);
          }
        } catch (err) {
          ctx.logger.error(`${def.kind}: poll failed: ${String(err)}`);
        }
      };

      // Fire-and-forget on a timer; first tick after one interval to avoid a
      // thundering startup burst.
      const timer = setInterval(() => void tick(), def.intervalMs);
      timer.unref?.();

      return {
        stop() {
          stopped = true;
          clearInterval(timer);
        },
      };
    },
  });
}
