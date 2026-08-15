/**
 * Manual trigger. Fired by `steerium workflow run <name>` or the control
 * API. Always available. It does not produce events on its own; the runtime
 * holds the emit fn so a manual fire can push an event through.
 */
import { defineTrigger } from "../define.js";
import type { Trigger, TriggerHandle } from "../types.js";

export interface ManualEvent {
  source: "manual";
  /** Optional arbitrary payload passed by the caller. */
  input?: unknown;
}

export interface ManualTrigger extends Trigger<ManualEvent> {
  readonly kind: "manual";
}

export function manual(): ManualTrigger {
  return defineTrigger({
    kind: "manual",
    async start(): Promise<TriggerHandle> {
      // Manual triggers are inert until the runtime fires them directly.
      return { stop() {} };
    },
  }) as ManualTrigger;
}
