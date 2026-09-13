import { expect, test } from "bun:test";
import { aggregateCompletedWorkResults, validateWorkAssessment, workAssessmentStorageKey, workProgressScopeKey, type ReviewWorkAssessment } from "../src/review/work-results";
import { workHash, type ReviewWorkUnit, type ReviewWorkPlan } from "../src/review/work-plan";
import { reviewEvidenceManifestSchema } from "../src/review/evidence-bundle";
import { laneCompletedReportSchema } from "../src/review/lane-checkpoint";
import { authenticateCompletedReviewWork, signCompletedReviewWork } from "../src/review/work-storage";

const baseSha = "a".repeat(40), headSha = "b".repeat(40), inputDigest = "c".repeat(64);
const manifest = reviewEvidenceManifestSchema.parse({ schemaVersion: 1, baseSha, headSha, patchFingerprint: "d".repeat(64), entries: ["src/a.ts", "docs/readme.md"].map(path => ({ path, status: "modified", kind: "excluded", patchCharacters: 0, patchTokens: 0, patchSha256: "e".repeat(64), classification: ["generated"], addedLines: 0, deletedLines: 0 })) });
function unit(path: string): ReviewWorkUnit { return { id: workHash(["writing-quality", path]), axis: "writing-quality", component: path, paths: [path], requirementIds: [], policyDigest: "f".repeat(64) }; }
function assessment(target: ReviewWorkUnit): ReviewWorkAssessment {
  return { schemaVersion: 1, unit: target, inputDigest, sourceBaseSha: baseSha, sourceHeadSha: headSha, proof: { supportingBlob: "observed-blob" }, checkpoint: { status: "complete", reviewedEntries: [0], remainingEntries: [], observations: [], nextSteps: [], limitations: [], completedReport: laneCompletedReportSchema.parse({ axis: target.axis, scope: { claim: "Review the requested prose", dirtyState: "Clean", inspectedSupportingContext: ["docs/style.md"] }, coverage: { staticOnly: [], unreached: [] }, churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] }, probes: [{ commandOrAction: "inspect delivered prose", result: "Read all current text" }], candidates: [], verifiedClaims: ["Text is readable"], limitations: [], specialistChecks: [{ entries: [0], requirement: "Clear prose", source: "trusted style policy", expected: "unambiguous copy", environment: "current tree", action: "inspect text", observed: "text is clear", status: "passed" }], requirementChecks: [] }) } };
}
const units = manifest.entries.map(entry => unit(entry.path));
const plan: ReviewWorkPlan = { schemaVersion: 1, baseSha, headSha, patchFingerprint: manifest.patchFingerprint, units };
const results = units.map(assessment);
const aggregate = (records: readonly ReviewWorkAssessment[], overrides: Partial<Parameters<typeof aggregateCompletedWorkResults>[0]> = {}) => aggregateCompletedWorkResults({ plan, manifest, results: records, obligations: [], expectedInputDigest: () => inputDigest, validateProof: async () => true, ...overrides });

test("unit aggregation remaps local specialist entries and deduplicates only exact evidence", async () => {
  const [report] = await aggregate(results);
  expect(report!.axis).toBe("writing-quality");
  expect(report!.specialistChecks!.map(check => check.entries)).toEqual([[0], [1]]);
  expect(report!.probes).toHaveLength(1);
  const differing = structuredClone(results);
  differing[1]!.checkpoint.completedReport!.probes[0]!.result = "Read current text with a different observed result";
  expect((await aggregate(differing))[0]!.probes).toHaveLength(2);
});

test("omitted components, duplicate reports, added paths and local coverage gaps cannot complete", async () => {
  await expect(aggregate(results.slice(0, 1))).rejects.toThrow("every expected unit exactly once");
  await expect(aggregate([results[0]!, results[0]!])).rejects.toThrow("every expected unit exactly once");
  const expanded = structuredClone(results);
  expanded[0]!.unit.paths.push("new/unplanned.ts");
  await expect(aggregate(expanded)).rejects.toThrow("current semantic unit");
  const missing = structuredClone(results);
  missing[0]!.checkpoint.reviewedEntries = [];
  await expect(aggregate(missing)).rejects.toThrow("exact review scope");
  const badIndex = structuredClone(results);
  badIndex[0]!.checkpoint.completedReport!.specialistChecks![0]!.entries = [1];
  await expect(aggregate(badIndex)).rejects.toThrow("without expanding scope");
});

test("current supporting-dependency callback can invalidate otherwise identical historical work", async () => {
  const visited: string[] = [];
  await expect(aggregate(results, { validateProof: async (_record, expected) => { visited.push(expected.id); return false; } })).rejects.toThrow("supporting dependencies");
  expect(visited).toEqual([units[0]!.id]);
  await expect(aggregate(results, { expectedInputDigest: () => "0".repeat(64) })).rejects.toThrow("current semantic unit");
});

test("unfinished checkpoints and unverified specialist probes remain incomplete", async () => {
  const unfinished = structuredClone(results);
  unfinished[0]!.checkpoint = { ...unfinished[0]!.checkpoint, status: "in-progress", completedReport: null, reviewedEntries: [], remainingEntries: [0], nextSteps: ["Run required probe"] };
  await expect(aggregate(unfinished)).rejects.toThrow("not complete");
  const unverified = structuredClone(results);
  unverified[0]!.checkpoint.completedReport!.specialistChecks![0]!.status = "unverified";
  await expect(aggregate(unverified)).rejects.toThrow("Required verification remains unverified");
  expect(workAssessmentStorageKey(unfinished[0]!).scopeKey).toBe(workProgressScopeKey(units[0]!));
  expect(workAssessmentStorageKey(unfinished[0]!).scopeKey).not.toBe(workAssessmentStorageKey(results[0]!).scopeKey);
});

test("valid signed work crosses a head update without waiting for publication", async () => {
  const old = results[0]!;
  const secret = "ab".repeat(32);
  const context = { repositoryId: "R_1", pullRequest: 1, deliveryId: "unpublished-source-attempt" };
  const signed = signCompletedReviewWork(context, { ...workAssessmentStorageKey(old), data: JSON.stringify(old) }, secret);
  const recovered = authenticateCompletedReviewWork(signed, { ...context, deliveryId: "new-head-attempt" }, workAssessmentStorageKey(old), secret);
  let validated = false;
  const record = await validateWorkAssessment(JSON.parse(recovered.data), units[0]!, { inputDigest, obligations: [], requireComplete: true, validateProof: async candidate => { validated = candidate.sourceHeadSha === headSha; return true; } });
  expect(validated).toBe(true);
  expect(record.sourceHeadSha).toBe(headSha);
  const currentHead = "1".repeat(40);
  const aggregated = await aggregate(results, { plan: { ...plan, headSha: currentHead }, manifest: { ...manifest, headSha: currentHead } });
  expect(aggregated).toHaveLength(1);
});

test("different candidates and requirement observations survive exact-only deduplication", async () => {
  const records = structuredClone(results);
  const candidate = { title: "Confusing text", location: { path: "docs/readme.md", line: 1, symbol: null }, evidence: ["Observed misleading instruction"], impact: "Reader takes the wrong action", remedy: "Clarify the instruction", staticOnly: true, churn: null, uncertainty: [] };
  records[0]!.checkpoint.completedReport!.candidates = [candidate];
  records[1]!.checkpoint.completedReport!.candidates = [{ ...candidate, evidence: ["A distinct independently observed instruction"] }];
  const [report] = await aggregate(records);
  expect(report!.candidates).toHaveLength(2);
  records[1]!.checkpoint.completedReport!.candidates = [candidate];
  expect((await aggregate(records))[0]!.candidates).toHaveLength(1);
});

test("requirement observations preserve obligation identity and differing outcomes", async () => {
  const records = structuredClone(results);
  const sourceId = `req-${"1".repeat(24)}`, obligationId = `ob-${"2".repeat(24)}`;
  for (const record of records) {
    record.unit.requirementIds = [sourceId];
    record.checkpoint.completedReport!.requirementChecks = [{ sourceId, obligationId, requirement: "Explain the command", establishedRequirement: "Document the public interface", basis: "established", proposedChange: "Updated prose", approvalEvidence: null, expected: "Correct command description", observed: "The command is described", action: "Read delivered documentation", environment: "current docs", status: "passed" }];
  }
  records[1]!.checkpoint.completedReport!.requirementChecks![0]!.status = "failed";
  records[1]!.checkpoint.completedReport!.requirementChecks![0]!.observed = "The independent example contradicts the command";
  const [report] = await aggregate(records, { plan: { ...plan, units: records.map(record => record.unit) }, obligations: [{ id: obligationId, sourceId }] });
  expect(report!.requirementChecks!.map(check => check.status)).toEqual(["passed", "failed"]);
  expect(report!.requirementChecks!.every(check => check.obligationId === obligationId)).toBe(true);
  records[1]!.checkpoint.completedReport!.requirementChecks![0]!.obligationId = `ob-${"3".repeat(24)}`;
  await expect(aggregate(records, { plan: { ...plan, units: records.map(record => record.unit) }, obligations: [{ id: obligationId, sourceId }] })).rejects.toThrow("prepared source");
});

test("reused local specialist indices remap after current manifest ordering changes", async () => {
  const [report] = await aggregate(results, { manifest: { ...manifest, entries: [...manifest.entries].reverse() } });
  expect(report!.specialistChecks!.map(check => check.entries)).toEqual([[1], [0]]);
});
