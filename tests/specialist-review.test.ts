import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { reviewInstructions } from "../src/review/policy";
import { reviewLaneCheckpointInputSchema } from "../agent/tools/review_lane_checkpoint";
import { readNextReviewEvidencePacket, reviewEvidenceManifestSchema, reviewEvidencePatchFile, reviewEvidencePacketCharacters, writeIncludedReviewEvidence, type ReviewEvidenceManifest } from "../src/review/evidence-bundle";
import { validateLaneCheckpointCoverage, writeLaneCheckpoint, type LaneCompletedReport } from "../src/review/lane-checkpoint";
import { retainSpecialistEvidence } from "../src/review/specialist-report";
import { assembleCanonicalReviewReport, beginReportAssembly, type ReviewReportDraft } from "../src/review/report-assembly";
import { checkpointContent, identity } from "./fixtures/eve-runtime-smoke/agent/lib/orchestration";

function sandboxFixture() {
  const files = new Map<string, string>();
  return {
    async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; },
    async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content); },
    async removePath({ path }: { path: string }) { files.delete(path); },
  };
}

const check = {
  entries: [0], requirement: "The CLI rejects missing inputs", source: "docs/requirements.md at exact head",
  expected: "Nonzero exit with a useful diagnostic", environment: "Local exact-head CLI",
  action: "cli validate --input missing", observed: "No runtime available in this fixture", status: "unverified" as const,
};

describe("specialist evidence obligations", () => {
  test.each([
    ["omitted", "nested/"], ["excluded", "nested/"],
    ["omitted", 'quote"\n/'], ["excluded", 'quote"\n/'],
  ] as const)("%s metadata with %j paths stays bounded without losing obligations", async (kind, segment) => {
    const sandbox = sandboxFixture();
    const source = await writeIncludedReviewEvidence(sandbox, { patchFingerprint: identity.patchFingerprint, path: "src/template.ts", patch: "+source\n", patchTokens: 2, status: "modified" });
    const manifest = reviewEvidenceManifestSchema.parse({ schemaVersion: 1, ...identity, entries: Array.from({ length: 2000 }, (_, index) => {
      const path = `src/${segment.repeat(40)}file-${index}.ts`;
      return kind === "omitted"
        ? { ...source, path, patchFile: reviewEvidencePatchFile(identity.patchFingerprint, path).fileName }
        : { ...source, kind: "excluded", path, classification: ["generated"], addedLines: 1, deletedLines: 0 };
    }) });
    const axis = kind === "omitted" ? "test-against-spec" : "engineering-quality";
    const delivered: number[] = [];
    for (let revision = 0; revision < 20; revision += 1) {
      const packet = await readNextReviewEvidencePacket(sandbox, manifest, axis, `bounded-${revision}`, revision);
      expect(JSON.stringify(packet).length).toBeLessThanOrEqual(reviewEvidencePacketCharacters);
      expect(packet.entries.length).toBeGreaterThan(0);
      expect(await readNextReviewEvidencePacket(sandbox, manifest, axis, `replacement-${revision}`, revision)).toEqual(packet);
      delivered.push(...packet.entries.map((entry) => entry.index));
      if (packet.nextCursor === null) {
        expect(packet.completedEntries).toEqual(Array.from({ length: 2000 }, (_, index) => index));
        break;
      }
    }
    expect(delivered).toEqual(Array.from({ length: 2000 }, (_, index) => index));
  });

  test("escaped patch text is charged after serialization and reconstructs across packets", async () => {
    const sandbox = sandboxFixture();
    const patch = '+"\\\n🙂'.repeat(110_000);
    const entry = await writeIncludedReviewEvidence(sandbox, { patchFingerprint: identity.patchFingerprint, path: "src/escaped.ts", patch, patchTokens: 110_000, status: "modified" });
    const manifest: ReviewEvidenceManifest = { schemaVersion: 1, ...identity, entries: [entry] };
    let delivered = "";
    for (let revision = 0; revision < 20; revision += 1) {
      const packet = await readNextReviewEvidencePacket(sandbox, manifest, "engineering-quality", `escaped-${revision}`, revision);
      expect(JSON.stringify(packet).length).toBeLessThanOrEqual(reviewEvidencePacketCharacters);
      const fragment = packet.entries[0]?.content ?? "";
      expect(fragment.length).toBeGreaterThan(0);
      expect(new TextDecoder().decode(new TextEncoder().encode(fragment))).toBe(fragment);
      delivered += fragment;
      if (packet.nextCursor === null) break;
    }
    expect(delivered).toBe(patch);
  });

  test("scoped packets retain every manifest index and core patches while omitting spec implementation payloads", async () => {
    const sandbox = sandboxFixture();
    const source = await writeIncludedReviewEvidence(sandbox, { patchFingerprint: identity.patchFingerprint, path: "src/main.ts", patch: "+implementation-only\n", patchTokens: 4, status: "modified" });
    const spec = await writeIncludedReviewEvidence(sandbox, { patchFingerprint: identity.patchFingerprint, path: "docs/requirements.md", patch: "+CLI must reject missing input\n", patchTokens: 7, status: "modified" });
    const lock = await writeIncludedReviewEvidence(sandbox, { patchFingerprint: identity.patchFingerprint, path: "bun.lock", patch: "+dependency graph\n", patchTokens: 3, status: "modified" });
    const manifest: ReviewEvidenceManifest = { schemaVersion: 1, ...identity, entries: [source, spec, lock] };
    const core = await readNextReviewEvidencePacket(sandbox, manifest, "engineering-quality", "core", 0);
    const specialist = await readNextReviewEvidencePacket(sandbox, manifest, "test-against-spec", "spec", 0);
    expect(core.entries.map((entry) => entry.content)).toEqual(["+implementation-only\n", "+CLI must reject missing input\n", "+dependency graph\n"]);
    expect(specialist.completedEntries).toEqual([0, 1, 2]);
    expect(specialist.entries[0]).toMatchObject({ index: 0, patchOmissionReason: expect.any(String), obligation: expect.any(String) });
    expect(specialist.entries[0]).not.toHaveProperty("content");
    expect(specialist.entries[1]?.content).toBe("+CLI must reject missing input\n");
    expect(await readNextReviewEvidencePacket(sandbox, manifest, "test-against-spec", "replacement", 0)).toEqual(specialist);
    const writing = await readNextReviewEvidencePacket(sandbox, manifest, "writing-quality", "writing", 0);
    expect(writing.completedEntries).toEqual([0, 1, 2]);
    expect(writing.entries[0]?.content).toBe("+implementation-only\n");
    expect(writing.entries[2]).not.toHaveProperty("content");
    const health = await readNextReviewEvidencePacket(sandbox, manifest, "test-health", "health", 0);
    expect(health.completedEntries).toEqual([0, 1, 2]);
    expect(health.entries[0]).not.toHaveProperty("content");
    expect(health.entries[1]?.content).toBe("+CLI must reject missing input\n");
    expect(health.entries[0]?.obligation).toContain("frozen external contract");
  });

  test("complete specialist checkpoints reject missing, partial or expanded obligations", async () => {
    const content = checkpointContent("test-against-spec");
    content.reviewedEntries = [0, 1];
    if (!content.completedReport) throw new Error("Expected complete fixture");
    content.completedReport.specialistChecks = [check];
    await expect(writeLaneCheckpoint(sandboxFixture(), identity, "test-against-spec", content, 2)).rejects.toThrow("every manifest entry");
    content.completedReport.specialistChecks = [{ ...check, entries: [0, 1, 2] }];
    expect(() => validateLaneCheckpointCoverage(content, 2)).toThrow("without expanding scope");
    content.completedReport.specialistChecks = [{ ...check, entries: [0, 1] }];
    expect(() => validateLaneCheckpointCoverage(content, 2)).toThrow("Required verification remains unverified");
    content.completedReport.specialistChecks = [{ ...check, entries: [0, 1], status: "passed", observed: "CLI exits nonzero with diagnostic" }];
    expect(() => validateLaneCheckpointCoverage(content, 2)).not.toThrow();
    content.completedReport.specialistChecks = null;
    expect(() => validateLaneCheckpointCoverage(content, 2)).toThrow("explicit coverage checks");
  });

  test("the actual tool JSON Schema exposes closed, required specialist evidence fields", async () => {
    const schema = await asSchema(reviewLaneCheckpointInputSchema).jsonSchema;
    expect(schema).toHaveProperty("properties.checkpoint.anyOf.0.properties.completedReport.anyOf.0.properties.specialistChecks.anyOf.0.items.additionalProperties", false);
    expect(schema).toHaveProperty("properties.checkpoint.anyOf.0.properties.completedReport.anyOf.0.properties.specialistChecks.anyOf.0.items.properties.status.enum", ["passed", "failed", "unverified", "out-of-scope"]);
  });

  test("all specialist outcomes reach canonical report assembly without coordinator restatement", () => {
    const draft: ReviewReportDraft = { actionSummary: "CLI evidence retained", additionalConcerns: [], scope: { claim: "CLI validation", dirtyState: "clean" }, coverage: { staticOnly: [], unreached: [] }, churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] }, probes: [], freshFindings: [], verifiedClaims: [], limitations: [] };
    const completed = checkpointContent("test-against-spec").completedReport;
    if (!completed) throw new Error("Expected complete fixture");
    const report: LaneCompletedReport = { ...completed, specialistChecks: ["passed", "failed", "unverified", "out-of-scope"].map((status) => ({ ...check, status: status as "passed" | "failed" | "unverified" | "out-of-scope" })) };
    const retained = retainSpecialistEvidence(draft, [report]);
    const assemble = (input: ReviewReportDraft) => assembleCanonicalReviewReport({ draft: input, generatedAt: "2026-09-10T00:00:00.000Z", priorReport: null, state: beginReportAssembly({ executionRevision: "review-report-v2", repositoryId: "R_fixture", pullRequest: 1, ...identity, planKind: "full", baselineHead: null, reviewPaths: ["src/main.ts"], activeAxes: ["test-against-spec"], selectedFindingIds: [] }) });
    expect(() => assemble(retained)).toThrow("verification");
    expect(retained.probes).toHaveLength(4);
    expect(retained.limitations).toHaveLength(3);
    expect(retained.coverage.unreached[0]).toContain("unverified");
    const verified = retainSpecialistEvidence(draft, [{ ...report, specialistChecks: [{ ...check, status: "passed", observed: "Exact-head CLI rejected the invalid input" }] }]);
    expect(assemble(verified).report?.probes).toHaveLength(1);
    expect(assemble(verified).report?.verifiedClaims).toEqual([]);
    expect(retainSpecialistEvidence(retained, [report])).toEqual(retained);
  });
});

test("role-specific policies retain review authority without handing lanes coordinator procedure", () => {
  const coordinator = reviewInstructions({ role: "coordinator", attempt: 0 });
  const spec = reviewInstructions({ role: "lane", axis: "test-against-spec", attempt: 0 });
  const writing = reviewInstructions({ role: "lane", axis: "writing-quality", attempt: 0 });
  const health = reviewInstructions({ role: "lane", axis: "test-health", attempt: 0 });
  for (const policy of [coordinator, spec, writing, reviewInstructions({ role: "scout", attempt: 0 })]) {
    expect(policy).toContain("Slop Sheriff");
    expect(policy).toContain("Never push, merge");
    expect(policy).not.toContain("Load the installed");
  }
  expect(coordinator).toContain("Call workflow once");
  expect(spec).not.toContain("Call workflow once");
  expect(spec).toContain("Source, unit tests, mocks, snapshots and patches cannot establish behavioral success");
  expect(spec).toContain("absent/conflicting specification is unverified");
  expect(writing).toContain("Do not claim AI authorship");
  expect(writing).toContain("exact economical rewrite");
  expect(health).toContain("Freeze these expectations before running the candidate");
  expect(health).toContain("tolerate behavior-preserving refactors");
  expect(health).toContain("Never derive expected values from the implementation");
  expect(health).toContain("Do not infer when or by whom tests were written");
});

test("required source evidence cannot disappear during canonical assembly", async () => {
  const sourceId = `req-${"a".repeat(24)}`;
  const report = checkpointContent("claim-and-specification").completedReport!;
  report.requirementChecks = [{ sourceId, obligationId: null, requirement: "Invalid CLI input must fail", basis: "established", establishedRequirement: "docs/DoD.md at base requires exit 1", proposedChange: "Head documentation now claims exit 0 is successful", approvalEvidence: null, expected: "Exit 1 with diagnostic", observed: "Exact head CLI exits 0", action: "cli --invalid", environment: "Local exact head", status: "failed" }];
  const draft: ReviewReportDraft = { actionSummary: "Correct invalid-input behavior and its documentation", additionalConcerns: [], scope: { claim: "CLI validation", dirtyState: "clean" }, coverage: { staticOnly: [], unreached: [] }, churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] }, probes: [], freshFindings: [], verifiedClaims: [], limitations: [] };
  expect(() => retainSpecialistEvidence(draft, [report])).toThrow("must remain a material claim finding");
  draft.freshFindings.push({ severity: "IMPORTANT", category: "CLAIM", title: "Restore invalid-input rejection", introduction: "The CLI accepts invalid input despite the established completion requirement, allowing callers to treat malformed requests as successful operations.", principle: "Preserve the documented public CLI exit contract", risk: "Callers that trust exit status may continue after validation fails.", location: { path: "src/cli.ts", line: 1, symbol: null }, evidence: ["docs/DoD.md at base requires exit 1; head CLI exits 0", "Head docs remove rejection without maintainer approval"], impact: "Invalid requests pass validation", impactSummary: "Invalid requests pass validation", remedy: "Restore rejection or obtain explicit approval for the product change", staticOnly: false, churn: null, requirementIds: [sourceId] });
  const retained = retainSpecialistEvidence(draft, [report]);
  expect(retained.probes[0]?.result).toContain("Established: docs/DoD.md at base requires exit 1");
  expect(retained.probes[0]?.result).toContain("Proposed: Head documentation now claims exit 0");
  const assembled = assembleCanonicalReviewReport({ draft: retained, generatedAt: "2026-09-12T00:00:00.000Z", priorReport: null, state: beginReportAssembly({ executionRevision: "review-report-v2", repositoryId: "R_fixture", pullRequest: 1, ...identity, planKind: "full", baselineHead: null, reviewPaths: ["src/cli.ts"], activeAxes: ["claim-and-specification"], selectedFindingIds: [] }) });
  expect(assembled.report?.findings[0]).toMatchObject({ severity: "IMPORTANT", category: "CLAIM", requirementIds: [sourceId] });
  const schema = await asSchema(reviewLaneCheckpointInputSchema).jsonSchema;
  expect(schema).toHaveProperty("properties.checkpoint.anyOf.0.properties.completedReport.anyOf.0.properties.requirementChecks.anyOf.0.items.additionalProperties", false);
  expect(schema).toHaveProperty("properties.checkpoint.anyOf.0.properties.completedReport.anyOf.0.properties.requirementChecks.anyOf.0.items.required", expect.arrayContaining(["sourceId", "obligationId", "basis", "establishedRequirement", "proposedChange", "approvalEvidence", "expected", "observed", "action", "environment", "status"]));
});
