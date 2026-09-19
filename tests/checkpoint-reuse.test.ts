import { expect, test } from "bun:test";
import { reusableReviewWork } from "../agent/lib/review-workflow";
import { workOrchestrationFixture } from "./work-orchestration-fixture";

test("workflow reuse consumes signed prepared assessments without a VM or fake current invocation", async () => {
  const f = workOrchestrationFixture(); const pending = f.plan.prepared.units[0]!;
  expect(await reusableReviewWork(f.reader, f.plan, pending)).toBeNull();
  const unit = { ...pending, status: "reused" as const, reusableAssessment: f.assessments.get(pending.id)! };
  expect((await reusableReviewWork(f.reader, f.plan, unit))?.checkpoint.status).toBe("complete");
  await expect(reusableReviewWork(f.reader, f.plan, { ...unit, inputDigest: "f".repeat(64) })).rejects.toThrow("packet identity mismatch");
  await expect(reusableReviewWork(f.reader, f.plan, { ...unit, reusableAssessment: null })).rejects.toThrow("missing its validated assessment");
  const stale = structuredClone(unit); stale.reusableAssessment!.unit.policyDigest = "f".repeat(64);
  await expect(reusableReviewWork(f.reader, f.plan, stale)).rejects.toThrow("current semantic unit");
});
