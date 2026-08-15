/** Typed structured output: the provider enforces JSON and Steerium parses data. */
import { defineWorkflow, manual } from "steerium";

interface Triage {
  severity: "low" | "medium" | "high";
  owner: string;
  summary: string;
}

export default defineWorkflow({
  name: "structured-triage",
  on: manual(),
  async run(ctx) {
    const result = await ctx.step("triage", () =>
      ctx.agent.run<Triage>({
        provider: "openai",
        prompt: `Triage this input:\n\n${JSON.stringify(ctx.event.input)}`,
        outputSchema: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["low", "medium", "high"] },
            owner: { type: "string" },
            summary: { type: "string" },
          },
          required: ["severity", "owner", "summary"],
          additionalProperties: false,
        },
      }),
    );

    await ctx.artifact.writeJSON("triage.json", result.data);
  },
});
