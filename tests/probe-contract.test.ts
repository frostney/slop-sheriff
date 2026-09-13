import { expect, test } from "bun:test";
import { asSchema, generateText, stepCountIs, tool } from "ai";
import { mockModel } from "eve/evals";
import probeTool, { runReviewProbeInputSchema } from "../agent/tools/run_review_probe";

const input = { command: "bun test", cwd: ".", stdin: null, environment: [], rerun: false };

test("generated probe schema excludes provenance and rejects forged application fields", async () => {
  expect(probeTool.inputSchema).toBe(runReviewProbeInputSchema);
  const generated = await asSchema(runReviewProbeInputSchema).jsonSchema;
  expect(generated).toHaveProperty("additionalProperties", false);
  expect(generated.required).toEqual(["command", "cwd", "stdin", "environment", "rerun"]);
  expect(generated).toHaveProperty("properties.environment.items.additionalProperties", false);
  for (const field of ["probeId", "executionId", "sourceDigest", "environmentDigest", "receipt", "reusable", "passed", "workId", "headSha"]) {
    expect(generated).not.toHaveProperty(`properties.${field}`);
    expect(runReviewProbeInputSchema.safeParse({ ...input, [field]: "forged" }).success).toBe(false);
  }
  for (const cwd of ["..", "x/../y", "/tmp", "$(pwd)", "a//b", ".git", "x/.git/hooks", "x\0y"]) {
    expect(runReviewProbeInputSchema.safeParse({ ...input, cwd }).success).toBe(false);
  }
  expect(runReviewProbeInputSchema.safeParse({ ...input, environment: [{ name: "A", value: "1" }, { name: "A", value: "2" }] }).success).toBe(false);
  expect(runReviewProbeInputSchema.safeParse({ ...input, environment: [{ name: "A; touch x", value: "1" }] }).success).toBe(false);
});

test("official Eve mock reaches SDK schema validation before the executable probe boundary", async () => {
  let steps = 0;
  let executions = 0;
  const result = await generateText({
    model: mockModel(() => ++steps === 1
      ? { toolCalls: [{ name: "run_review_probe", input: { ...input, sourceDigest: "forged" } }] }
      : steps === 2 ? { toolCalls: [{ name: "run_review_probe", input }] } : "complete"),
    prompt: "Run the required check", stopWhen: stepCountIs(3),
    tools: { run_review_probe: tool({ inputSchema: runReviewProbeInputSchema, execute: async (parsed) => {
      executions += 1;
      expect(parsed).toEqual(input);
      return { exitCode: 0, stdout: "verified", stderr: "" };
    } }) },
  });
  expect(executions).toBe(1);
  expect(result.steps[0]?.toolResults).toHaveLength(0);
  expect(result.steps[1]?.toolResults).toHaveLength(1);
  expect(result.text).toBe("complete");
});
