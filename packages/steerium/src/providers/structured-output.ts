import type {
  AgentOutputSchema,
  AgentResult,
  StandardOutputSchema,
} from "../types.js";

function standardSchema<T>(schema: AgentOutputSchema<T>): StandardOutputSchema<T> | undefined {
  return "~standard" in schema ? (schema as StandardOutputSchema<T>) : undefined;
}

export function outputJsonSchema<T>(schema: AgentOutputSchema<T>): Record<string, unknown> {
  const standard = standardSchema(schema);
  if (!standard) return schema as Record<string, unknown>;
  const convert = standard["~standard"].jsonSchema?.output;
  if (!convert) {
    throw new Error(
      "structured output schema implements Standard Schema validation but not ~standard.jsonSchema.output",
    );
  }
  return convert({ target: "draft-07" });
}

export async function normalizeStructuredResult<T>(
  schema: AgentOutputSchema<T>,
  result: AgentResult,
): Promise<AgentResult<T>> {
  let value = result.data;
  if (value === undefined) {
    try {
      value = JSON.parse(result.text);
    } catch (error) {
      throw new Error(
        `provider returned invalid JSON for structured output: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const standard = standardSchema(schema);
  if (standard) {
    const validated = await standard["~standard"].validate(value);
    if ("issues" in validated && validated.issues) {
      throw new Error(`structured output validation failed: ${JSON.stringify(validated.issues)}`);
    }
    value = validated.value;
  }
  return { ...result, data: value as T };
}
