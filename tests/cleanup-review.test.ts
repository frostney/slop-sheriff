import { expect, test } from "bun:test";
import { reviewTool as cleanupReview } from "../agent/tools/cleanup_review";

test("cleanup removes evidence, always stops compute, and propagates deletion failures", async () => {
  const execute = cleanupReview.execute;
  if (!execute) throw new Error("Cleanup tool must have an executor");
  for (const outcome of [0, 1, new Error("transport failed")]) {
    let stopped = false;
    let command = "";
    const ctx = {
      session: { auth: { current: { attributes: { known_good_review_plan: "cleanup" } } } },
      getSandbox: async () => ({
        id: "sandbox",
        run: async (input: { command: string }) => {
          command = input.command;
          if (outcome instanceof Error) throw outcome;
          return { exitCode: outcome };
        },
        stop: async () => { stopped = true; },
      }),
    } as unknown as Parameters<typeof execute>[1];
    if (outcome === 0) {
      expect(await execute({}, ctx)).toEqual({ cleaned: true, sandboxId: "sandbox" });
    } else {
      await expect(execute({}, ctx)).rejects.toThrow();
    }
    expect(stopped).toBe(true);
    expect(command).toContain("/tmp/known-good-review");
  }
});
