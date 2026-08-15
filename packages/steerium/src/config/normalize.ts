import type { SteeriumConfig, WorkflowDefinition } from "../types.js";

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new TypeError(`${path} has unknown field(s): ${unknown.join(", ")}`);
}

function optionalPositiveNumber(value: unknown, path: string, allowZero = false): void {
  if (value === undefined) return;
  const minimum = allowZero ? 0 : 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${path} must be a finite number >= ${minimum}`);
  }
}

/** Validate a loaded workflow module without changing the defineWorkflow helper. */
export function normalizeWorkflowDefinition(
  value: unknown,
  file: string,
): WorkflowDefinition<unknown> {
  const def = object(value, `workflow ${file}`);
  exact(def, ["name", "on", "run", "concurrency", "queue", "timeoutMs", "tags"], `workflow ${file}`);
  if (typeof def.name !== "string" || !def.name.trim()) {
    throw new TypeError(`workflow ${file}.name must be a non-empty string`);
  }
  const trigger = object(def.on, `workflow ${file}.on`);
  if (typeof trigger.kind !== "string" || typeof trigger.start !== "function") {
    throw new TypeError(`workflow ${file}.on must be a Trigger with kind and start`);
  }
  if (typeof def.run !== "function") throw new TypeError(`workflow ${file}.run must be a function`);
  optionalPositiveNumber(def.concurrency, `workflow ${file}.concurrency`);
  optionalPositiveNumber(def.queue, `workflow ${file}.queue`, true);
  optionalPositiveNumber(def.timeoutMs, `workflow ${file}.timeoutMs`);
  if (
    def.tags !== undefined &&
    (!Array.isArray(def.tags) || def.tags.some((tag) => typeof tag !== "string" || !tag))
  ) {
    throw new TypeError(`workflow ${file}.tags must be an array of non-empty strings`);
  }
  return def as unknown as WorkflowDefinition<unknown>;
}

/** Validate config eagerly so typos fail at startup instead of being ignored. */
export function normalizeConfig(value: unknown, file: string): SteeriumConfig {
  const config = object(value, `config ${file}`);
  exact(config, ["providers", "connectors", "projects", "defaults", "control"], `config ${file}`);

  if (config.providers !== undefined) {
    const providers = object(config.providers, `config ${file}.providers`);
    for (const [name, provider] of Object.entries(providers)) {
      object(provider, `config ${file}.providers.${name}`);
    }
  }
  if (config.connectors !== undefined) {
    const connectors = object(config.connectors, `config ${file}.connectors`);
    for (const [name, settings] of Object.entries(connectors)) {
      object(settings, `config ${file}.connectors.${name}`);
    }
  }
  if (
    config.projects !== undefined &&
    (!Array.isArray(config.projects) || config.projects.some((project) => typeof project !== "string"))
  ) {
    throw new TypeError(`config ${file}.projects must be an array of strings`);
  }

  if (config.defaults !== undefined) {
    const defaults = object(config.defaults, `config ${file}.defaults`);
    exact(
      defaults,
      ["provider", "concurrency", "timeoutMs", "queue", "shutdownGraceMs"],
      `config ${file}.defaults`,
    );
    if (defaults.provider !== undefined && typeof defaults.provider !== "string") {
      throw new TypeError(`config ${file}.defaults.provider must be a string`);
    }
    optionalPositiveNumber(defaults.concurrency, `config ${file}.defaults.concurrency`);
    optionalPositiveNumber(defaults.timeoutMs, `config ${file}.defaults.timeoutMs`);
    optionalPositiveNumber(defaults.queue, `config ${file}.defaults.queue`, true);
    optionalPositiveNumber(defaults.shutdownGraceMs, `config ${file}.defaults.shutdownGraceMs`, true);
  }

  if (config.control !== undefined) {
    const control = object(config.control, `config ${file}.control`);
    exact(control, ["port", "host", "token", "ui", "maxBodyBytes"], `config ${file}.control`);
    optionalPositiveNumber(control.port, `config ${file}.control.port`);
    optionalPositiveNumber(control.maxBodyBytes, `config ${file}.control.maxBodyBytes`);
    if (control.host !== undefined && typeof control.host !== "string") {
      throw new TypeError(`config ${file}.control.host must be a string`);
    }
    if (control.token !== undefined && typeof control.token !== "string") {
      throw new TypeError(`config ${file}.control.token must be a string`);
    }
    if (control.ui !== undefined && typeof control.ui !== "boolean") {
      throw new TypeError(`config ${file}.control.ui must be a boolean`);
    }
  }

  return config as SteeriumConfig;
}
