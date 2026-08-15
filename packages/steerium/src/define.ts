/**
 * Vite-style identity helpers. Zero runtime magic: they exist for type
 * inference and to give built-ins and third-party packages a stable, public
 * extension point. The runtime never special-cases anything passed through here.
 */
import type {
  Provider,
  SteeriumConfig,
  Trigger,
  WorkflowDefinition,
} from "./types.js";

export function defineWorkflow<E>(def: WorkflowDefinition<E>): WorkflowDefinition<E> {
  return def;
}

export function defineConfig(config: SteeriumConfig): SteeriumConfig {
  return config;
}

export function defineProvider(provider: Provider): Provider {
  return provider;
}

export function defineTrigger<E>(trigger: Trigger<E>): Trigger<E> {
  return trigger;
}

/** Convention for packaging triggers + actions for one external system. */
export function defineConnector<T>(connector: T): T {
  return connector;
}
