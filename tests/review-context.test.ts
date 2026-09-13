import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
import { asSchema } from "ai";
import { readReviewEvidenceInputSchema } from "../agent/tools/read_review_evidence";
import { reviewLaneCheckpointInputSchema } from "../agent/tools/review_lane_checkpoint";
import { reviewRecoveryInputSchema } from "../agent/tools/review_recovery";
import { publishReviewInputSchema } from "../agent/tools/publish_review";
import { assembleReviewReportInputSchema } from "../agent/tools/assemble_review_report";
import { recordReviewRevalidationInputSchema } from "../agent/tools/record_review_revalidation";
import {
  readReviewEvidenceManifest,
  readNextReviewEvidencePacket,
  readReviewEvidenceProgress,
  readReviewEvidencePatch,
  reviewEvidenceManifestSchema,
  resetReviewEvidence,
  reviewEvidenceManifestPath,
  reviewEvidencePage,
  reviewEvidencePatchFile,
  writeIncludedReviewEvidence,
  writeReviewEvidenceManifest,
  type ReviewEvidenceManifest,
} from "../src/review/evidence-bundle";
import {
  laneCompletedReportSchema,
  laneCheckpointContentSchema,
  laneCheckpointPath,
  readLaneCheckpoint,
  validateLaneCheckpointCoverage,
  validateLaneCheckpointEvidenceProgress,
  writeLaneCheckpoint,
} from "../src/review/lane-checkpoint";


const identity = {
  baseSha: "1".repeat(40),
  headSha: "2".repeat(40),
  patchFingerprint: "3".repeat(64),
  evidenceDigest: "4".repeat(64),
};

function completedLaneReport(
  axis:
    | "deduplication"
    | "claim-and-specification"
    | "engineering-quality"
    | "discoverability",
) {
  return {
    axis,
    scope: {
      claim: "Review the complete immutable evidence packet.",
      dirtyState: "clean",
      inspectedSupportingContext: ["src/review.ts"],
    },
    coverage: { staticOnly: [], unreached: [] },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [{ commandOrAction: "bun test", result: "passed" }],
    candidates: [],
    verifiedClaims: ["The review path remains read-only."],
    limitations: [],
    specialistChecks: null,
  };
}

function memorySandbox() {
  const files = new Map<string, string>();
  return {
    files,
    runtime: {
      async readTextFile({ path }: { readonly path: string }) {
        return files.get(path) ?? null;
      },
      async removePath({ path }: { readonly path: string }) {
        for (const filePath of files.keys()) {
          if (filePath === path || filePath.startsWith(`${path}/`)) {
            files.delete(filePath);
          }
        }
      },
      async writeTextFile({
        path,
        content,
      }: {
        readonly path: string;
        readonly content: string;
      }) {
        files.set(path, content);
      },
    },
  };
}

describe("review evidence bundle", () => {
  test("exports complete canonical revalidation variants through the AI SDK schema", async () => {
    const schema = await asSchema(recordReviewRevalidationInputSchema).jsonSchema;
    const variants = schema.properties?.findings;
    expect(variants).toHaveProperty("type", "array");
    expect(variants).toHaveProperty("maxItems", 100);
    const itemSchema = z.object({ items: z.object({ oneOf: z.array(z.object({
      required: z.array(z.string()),
      properties: z.record(z.string(), z.unknown()),
      additionalProperties: z.literal(false),
    })) }) }).parse(variants);
    expect(itemSchema.items.oneOf).toHaveLength(4);
    for (const variant of itemSchema.items.oneOf) {
      expect(variant.required).toEqual(expect.arrayContaining(["id", "status", "category", "churn", "location", "evidence"]));
      expect(variant.properties.location).toHaveProperty("properties.path.pattern");
    }
  });

  test("model recovery can complete axes but cannot claim application-owned stages", async () => {
    const schema = await asSchema(reviewRecoveryInputSchema).jsonSchema;
    expect(JSON.stringify(schema)).not.toContain("report-reconciled");
    expect(JSON.stringify(schema)).not.toContain("revalidation-complete");
    expect(reviewRecoveryInputSchema.safeParse({ operation: "advance", stage: "axes-complete" }).success).toBe(true);
    for (const stage of ["revalidation-complete", "report-reconciled", "published"]) {
      expect(reviewRecoveryInputSchema.safeParse({ operation: "advance", stage }).success).toBe(false);
    }
  });

  test("exposes provider-compatible object schemas for variant tools", () => {
    expect(z.toJSONSchema(readReviewEvidenceInputSchema)).toHaveProperty(
      "type",
      "object",
    );
    const laneCheckpointToolSchema = z.toJSONSchema(
      reviewLaneCheckpointInputSchema,
    );
    expect(laneCheckpointToolSchema).toHaveProperty("type", "object");
    expect(laneCheckpointToolSchema).toHaveProperty(
      "properties.checkpoint.anyOf.0.properties.completedReport.anyOf.0.properties.candidates.items.required",
      [
        "title",
        "location",
        "evidence",
        "impact",
        "impactSummary",
        "remedy",
        "staticOnly",
        "churn",
        "uncertainty",
      ],
    );
    expect(laneCheckpointToolSchema).not.toHaveProperty(
      "properties.checkpoint.anyOf.0.properties.completedReport.anyOf.0.properties.candidates.items.properties.severity",
    );
    expect(
      z.toJSONSchema(reviewLaneCheckpointInputSchema).required,
    ).toContain("checkpoint");
    expect(z.toJSONSchema(reviewRecoveryInputSchema).required).toEqual([
      "operation",
      "stage",
    ]);
    expect(z.toJSONSchema(readReviewEvidenceInputSchema).required).toEqual([
      "operation",
      "path",
      "axis",
      "cursor",
    ]);
    expect(z.toJSONSchema(publishReviewInputSchema).required).toBeUndefined();
    expect(publishReviewInputSchema.safeParse({}).success).toBeTrue();
    expect(
      publishReviewInputSchema.safeParse({ report: {} }).success,
    ).toBeFalse();
    const reportAssemblyToolSchema = z.toJSONSchema(
      assembleReviewReportInputSchema,
    );
    expect(reportAssemblyToolSchema.required).toEqual(["draft"]);
    expect(reportAssemblyToolSchema).toHaveProperty(
      "properties.draft.required",
      ["actionSummary", "additionalConcerns", "freshFindings"],
    );
    expect(reportAssemblyToolSchema).toHaveProperty(
      "properties.draft.additionalProperties",
      false,
    );
    expect(reportAssemblyToolSchema).not.toHaveProperty(
      "properties.draft.properties.freshFindings.items.properties.status",
    );
    expect(reportAssemblyToolSchema).not.toHaveProperty(
      "properties.draft.properties.coverage.properties.skippedAxes",
    );
    expect(reportAssemblyToolSchema).toHaveProperty(
      "properties.draft.properties.freshFindings.items.oneOf",
    );
    expect(reportAssemblyToolSchema).toHaveProperty(
      "properties.draft.properties.freshFindings.items.oneOf.0.properties.category.const",
      "CLAIM",
    );
    expect(reportAssemblyToolSchema).toHaveProperty(
      "properties.draft.properties.freshFindings.items.oneOf.0.properties.churn.type",
      "null",
    );
    expect(reportAssemblyToolSchema).toHaveProperty(
      "properties.draft.properties.freshFindings.items.oneOf.2.properties.category.const",
      "ARCHITECTURE_RISK",
    );
    expect(reportAssemblyToolSchema).toHaveProperty(
      "properties.draft.properties.freshFindings.items.oneOf.2.properties.churn.type",
      "object",
    );
    expect(reportAssemblyToolSchema).toHaveProperty(
      "properties.draft.properties.freshFindings.items.oneOf.0.properties.location.properties.path.pattern",
    );
    expect(
      JSON.stringify(reportAssemblyToolSchema),
    ).not.toContain('"status"');
    expect(
      assembleReviewReportInputSchema.safeParse({
        draft: { freshFindings: [] },
      }).success,
    ).toBeFalse();
    expect(
      z.toJSONSchema(recordReviewRevalidationInputSchema).required,
    ).toEqual(["findings"]);
    expect(z.toJSONSchema(laneCheckpointContentSchema).required).toContain(
      "completedReport",
    );
    expect(z.toJSONSchema(laneCompletedReportSchema).required).toEqual([
      "axis",
      "scope",
      "coverage",
      "churn",
      "probes",
      "candidates",
      "verifiedClaims",
      "limitations",
    ]);
    expect(
      laneCheckpointContentSchema.safeParse({
        status: "complete",
        reviewedEntries: [0],
        remainingEntries: [],
        observations: [],
        nextSteps: [],
        limitations: [],
        completedReport: "Complete.",
      }).success,
    ).toBeFalse();
    expect(
      laneCompletedReportSchema.safeParse({
        ...completedLaneReport("engineering-quality"),
        candidates: [
          {
            title: "Candidate",
            location: { path: "src/review.ts", line: 1, symbol: null },
            evidence: ["src/review.ts:1 shows the mismatch."],
            impact: "The review can fail after paid lanes complete.",
            remedy: "Validate the typed lane report before reconciliation.",
            staticOnly: true,
            churn: null,
            uncertainty: [],
            severity: "IMPORTANT",
          },
        ],
      }).success,
    ).toBeFalse();
    expect(
      laneCompletedReportSchema.safeParse({
        ...completedLaneReport("engineering-quality"),
        verifiedClaims: Array.from({ length: 13 }, () => "x".repeat(2_000)),
      }).success,
    ).toBeFalse();
    expect(
      readReviewEvidenceInputSchema.safeParse({ operation: "patch" }).success,
    ).toBeFalse();
    expect(
      readReviewEvidenceInputSchema.safeParse({
        operation: "packet",
        path: null,
        axis: "engineering-quality",
        cursor: null,
      }).success,
    ).toBeTrue();
    expect(
      reviewLaneCheckpointInputSchema.safeParse({
        operation: "write",
        axis: "engineering-quality",
        checkpoint: null,
      }).success,
    ).toBeFalse();
    expect(
      reviewLaneCheckpointInputSchema.safeParse({
        operation: "read",
        axis: "engineering-quality",
        checkpoint: null,
      }).success,
    ).toBeTrue();
    expect(
      reviewLaneCheckpointInputSchema.safeParse({
        operation: "read",
        axis: "engineering-quality",
      }).success,
    ).toBeFalse();
    expect(
      reviewRecoveryInputSchema.safeParse({
        operation: "read",
        stage: null,
      }).success,
    ).toBeTrue();
    expect(
      reviewRecoveryInputSchema.safeParse({
        operation: "advance",
        stage: null,
      }).success,
    ).toBeFalse();
  });

  test("stores one content-addressed patch and returns bounded pages", async () => {
    const sandbox = memorySandbox();
    const patch = "@@ -1 +1 @@\n-old\n+new\n".repeat(1_000);
    await resetReviewEvidence(sandbox.runtime, identity.patchFingerprint);
    const included = await writeIncludedReviewEvidence(sandbox.runtime, {
      patchFingerprint: identity.patchFingerprint,
      path: "src/review.ts",
      patch,
      patchTokens: 7_000,
      status: "modified",
    });
    const excluded: ReviewEvidenceManifest["entries"][number] = {
      kind: "excluded",
      path: "assets/logo.png",
      status: "modified",
      classification: ["binary"],
      addedLines: 0,
      deletedLines: 0,
      patchCharacters: 20,
      patchTokens: 7,
      patchSha256: createHash("sha256").update("binary patch").digest("hex"),
    };
    await writeReviewEvidenceManifest(sandbox.runtime, {
      schemaVersion: 1,
      ...identity,
      entries: [included, excluded],
    });

    const manifest = await readReviewEvidenceManifest(
      sandbox.runtime,
      identity,
    );
    expect(reviewEvidencePage(manifest, 0)).toMatchObject({
      totalEntries: 2,
      nextCursor: null,
      entries: [{ index: 0 }, { index: 1 }],
    });
    const first = await readReviewEvidencePatch(sandbox.runtime, manifest, {
      path: "src/review.ts",
      cursor: 0,
    });
    expect(first.content.length).toBe(16_000);
    expect(first.nextCursor).toBe(16_000);
    const second = await readReviewEvidencePatch(sandbox.runtime, manifest, {
      path: "src/review.ts",
      cursor: first.nextCursor ?? 0,
    });
    expect(`${first.content}${second.content}`).toBe(patch);
  });

  test("rejects a changed patch and a mismatched trusted review", async () => {
    const sandbox = memorySandbox();
    const included = await writeIncludedReviewEvidence(sandbox.runtime, {
      patchFingerprint: identity.patchFingerprint,
      path: "src/review.ts",
      patch: "original",
      patchTokens: 1,
      status: "modified",
    });
    await writeReviewEvidenceManifest(sandbox.runtime, {
      schemaVersion: 1,
      ...identity,
      entries: [included],
    });
    const manifest = await readReviewEvidenceManifest(
      sandbox.runtime,
      identity,
    );
    const patchFile = reviewEvidencePatchFile(
      identity.patchFingerprint,
      "src/review.ts",
    );
    sandbox.files.set(patchFile.filePath, "changed");
    await expect(
      readReviewEvidencePatch(sandbox.runtime, manifest, {
        path: "src/review.ts",
        cursor: 0,
      }),
    ).rejects.toThrow("integrity validation");

    sandbox.files.set(
      reviewEvidenceManifestPath(identity.patchFingerprint),
      `${JSON.stringify({ ...manifest, headSha: "4".repeat(40) })}\n`,
    );
    await expect(
      readReviewEvidenceManifest(sandbox.runtime, identity),
    ).rejects.toThrow("does not match the trusted review");
  });

  test("rejects unsafe or duplicate manifest paths", () => {
    const entry = {
      kind: "excluded" as const,
      path: "src/review.ts",
      status: "modified" as const,
      classification: ["binary" as const],
      addedLines: 0,
      deletedLines: 0,
      patchCharacters: 20,
      patchTokens: 7,
      patchSha256: createHash("sha256").update("binary patch").digest("hex"),
    };
    expect(() =>
      reviewEvidenceManifestSchema.parse({
        schemaVersion: 1,
        ...identity,
        entries: [entry, entry],
      }),
    ).toThrow("paths must be unique");
    expect(() =>
      reviewEvidenceManifestSchema.parse({
        schemaVersion: 1,
        ...identity,
        entries: [{ ...entry, path: "../outside.ts" }],
      }),
    ).toThrow("repository-relative");
  });

  test("keeps Unicode scalar values intact at patch page boundaries", async () => {
    const sandbox = memorySandbox();
    const patch = `${"a".repeat(15_999)}😀tail`;
    const included = await writeIncludedReviewEvidence(sandbox.runtime, {
      patchFingerprint: identity.patchFingerprint,
      path: "src/unicode.ts",
      patch,
      patchTokens: 1,
      status: "modified",
    });
    await writeReviewEvidenceManifest(sandbox.runtime, {
      schemaVersion: 1,
      ...identity,
      entries: [included],
    });
    const manifest = await readReviewEvidenceManifest(
      sandbox.runtime,
      identity,
    );
    const first = await readReviewEvidencePatch(sandbox.runtime, manifest, {
      path: "src/unicode.ts",
      cursor: 0,
    });
    const second = await readReviewEvidencePatch(sandbox.runtime, manifest, {
      path: "src/unicode.ts",
      cursor: first.nextCursor ?? 0,
    });
    expect(first.content.endsWith("😀")).toBe(true);
    expect(`${first.content}${second.content}`).toBe(patch);
  });

  test("advances one bounded idempotent evidence packet per fresh session", async () => {
    const sandbox = memorySandbox();
    const patch = "x".repeat(600_000);
    const included = await writeIncludedReviewEvidence(sandbox.runtime, {
      patchFingerprint: identity.patchFingerprint,
      path: "src/large.ts",
      patch,
      patchTokens: 150_000,
      status: "modified",
    });
    await writeReviewEvidenceManifest(sandbox.runtime, {
      schemaVersion: 1,
      ...identity,
      entries: [included],
    });
    const manifest = await readReviewEvidenceManifest(
      sandbox.runtime,
      identity,
    );

    const first = await readNextReviewEvidencePacket(
      sandbox.runtime,
      manifest,
      "engineering-quality",
      "session-one",
      0,
    );
    expect(first.entries).toHaveLength(1);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(500_000);
    expect(first.entries[0]?.content?.length).toBeGreaterThan(0);
    expect(first.completedEntries).toEqual([]);
    expect(first.nextCursor).toEqual({
      entryIndex: 0,
      characterOffset: first.entries[0]?.content?.length ?? 0,
    });
    expect(
      await readNextReviewEvidencePacket(
        sandbox.runtime,
        manifest,
        "engineering-quality",
        "session-one",
        1,
      ),
    ).toEqual(first);

    // A new child after a crash must replay the packet whose checkpoint was
    // never committed, rather than treating delivery as completed review work.
    const resumed = await readNextReviewEvidencePacket(
      sandbox.runtime, manifest, "engineering-quality", "crash-recovery", 0,
    );
    expect(resumed).toEqual(first);

    const second = await readNextReviewEvidencePacket(
      sandbox.runtime,
      manifest,
      "engineering-quality",
      "session-two",
      1,
    );
    expect(JSON.stringify(second).length).toBeLessThanOrEqual(500_000);
    expect((first.entries[0]?.content ?? "") + (second.entries[0]?.content ?? "")).toBe("x".repeat(600_000));
    expect(second.completedEntries).toEqual([0]);
    expect(second.nextCursor).toBeNull();
    expect(
      await readReviewEvidenceProgress(
        sandbox.runtime,
        manifest,
        "engineering-quality",
      ),
    ).toEqual({ cursor: null, completedEntries: [0] });
  });

  test("recovers packet delivery interrupted at either progress or session persistence", async () => {
    // A lane can save an early checkpoint before requesting its first packet.
    for (const [interruptedWrite, revision] of [[2, 0], [3, 0], [2, 1]] as const) {
      const sandbox = memorySandbox();
      const entry = await writeIncludedReviewEvidence(sandbox.runtime, {
        patchFingerprint: identity.patchFingerprint, path: "src/a.ts",
        patch: "inspected but not yet checkpointed", patchTokens: 8, status: "modified",
      });
      const manifest = reviewEvidenceManifestSchema.parse({ schemaVersion: 1, ...identity, entries: [entry] });
      let writes = 0;
      const interrupted = {
        ...sandbox.runtime,
        async writeTextFile(input: { path: string; content: string }) {
          if (++writes === interruptedWrite) throw new Error("simulated interruption");
          await sandbox.runtime.writeTextFile(input);
        },
      };
      await expect(readNextReviewEvidencePacket(interrupted, manifest, "engineering-quality", "failed", revision))
        .rejects.toThrow("simulated interruption");
      const resumed = await readNextReviewEvidencePacket(sandbox.runtime, manifest, "engineering-quality", "replacement", revision);
      expect(resumed.entries[0]?.content).toBe("inspected but not yet checkpointed");
      expect(await readReviewEvidenceProgress(sandbox.runtime, manifest, "engineering-quality"))
        .toEqual({ cursor: null, completedEntries: [0] });
      expect(await readNextReviewEvidencePacket(sandbox.runtime, manifest, "engineering-quality", "failed", revision))
        .toEqual(resumed);
    }
  });

  test("rejects corrupted packet receipts and progress that skips evidence", async () => {
    const sandbox = memorySandbox();
    const entry = await writeIncludedReviewEvidence(sandbox.runtime, {
      patchFingerprint: identity.patchFingerprint, path: "src/a.ts",
      patch: "immutable evidence", patchTokens: 4, status: "modified",
    });
    const manifest = reviewEvidenceManifestSchema.parse({ schemaVersion: 1, ...identity, entries: [entry] });
    await readNextReviewEvidencePacket(sandbox.runtime, manifest, "engineering-quality", "first", 0);
    const receiptPath = [...sandbox.files.keys()].find((path) => path.endsWith("engineering-quality-revision-0.json"))!;
    const source = sandbox.files.get(receiptPath)!;
    const receipt = JSON.parse(source);
    receipt.packet.entries[0].content = "substituted evidence";
    sandbox.files.set(receiptPath, JSON.stringify(receipt));
    await expect(readNextReviewEvidencePacket(sandbox.runtime, manifest, "engineering-quality", "replacement", 0))
      .rejects.toThrow("integrity validation");
    sandbox.files.set(receiptPath, source);
    const progressPath = [...sandbox.files.keys()].find((path) => path.endsWith("/progress/engineering-quality.json"))!;
    for (const progress of [
      { cursor: null, completedEntries: [] },
      { cursor: { entryIndex: 0, characterOffset: 999 }, completedEntries: [] },
      { cursor: null, completedEntries: [1] },
    ]) {
      sandbox.files.set(progressPath, JSON.stringify(progress));
      await expect(readNextReviewEvidencePacket(sandbox.runtime, manifest, "engineering-quality", "replacement", 0))
        .rejects.toThrow("does not match the exact manifest");
    }
    sandbox.files.set(progressPath, JSON.stringify({ cursor: null, completedEntries: [0] }));
    sandbox.files.delete(receiptPath);
    await expect(readNextReviewEvidencePacket(sandbox.runtime, manifest, "engineering-quality", "replacement", 0))
      .rejects.toThrow("missing its checkpoint-bound receipt");
  });
});

describe("review lane checkpoint", () => {
  test("requires exact, non-overlapping finding-scope coverage", () => {
    expect(() =>
      validateLaneCheckpointCoverage(
        {
          status: "in-progress",
          reviewedEntries: [0],
          remainingEntries: [0],
          observations: [],
          nextSteps: [],
          limitations: [],
          completedReport: null,
        },
        1,
      ),
    ).toThrow("both reviewed and remaining");
    expect(() =>
      validateLaneCheckpointCoverage(
        {
          status: "complete",
          reviewedEntries: [0],
          remainingEntries: [],
          observations: [],
          nextSteps: [],
          limitations: [],
          completedReport: completedLaneReport("engineering-quality"),
        },
        2,
      ),
    ).toThrow("must match the exact review scope");
  });

  test("binds checkpoints to application-recorded packet coverage", () => {
    expect(() =>
      validateLaneCheckpointEvidenceProgress(
        {
          status: "in-progress",
          reviewedEntries: [0],
          remainingEntries: [1],
          observations: [],
          nextSteps: [],
          limitations: [],
          completedReport: null,
        },
        {
          completedEntries: [],
          cursor: { entryIndex: 0, characterOffset: 500_000 },
        },
      ),
    ).toThrow("application-recorded evidence coverage");
    expect(() =>
      validateLaneCheckpointEvidenceProgress(
        {
          status: "complete",
          reviewedEntries: [0],
          remainingEntries: [],
          observations: [],
          nextSteps: [],
          limitations: [],
          completedReport: completedLaneReport("engineering-quality"),
        },
        {
          completedEntries: [0],
          cursor: { entryIndex: 1, characterOffset: 0 },
        },
      ),
    ).toThrow("before its immutable evidence packets are exhausted");
  });

  test("persists compact progress for a fresh lane continuation", async () => {
    const sandbox = memorySandbox();
    const first = await writeLaneCheckpoint(
      sandbox.runtime,
      identity,
      "engineering-quality",
      {
        status: "in-progress",
        reviewedEntries: [0],
        remainingEntries: [1],
        observations: [
          {
            disposition: "lead",
            summary: "Trace the retry state transition.",
            evidence: ["src/a.ts:20"],
          },
        ],
        nextSteps: ["Inspect the caller in src/b.ts."],
        limitations: [],
        completedReport: null,
      },
      2,
    );
    expect(first.revision).toBe(1);
    expect(
      await readLaneCheckpoint(
        sandbox.runtime,
        identity,
        "engineering-quality",
      ),
    ).toEqual(first);
    await expect(
      readLaneCheckpoint(
        sandbox.runtime,
        { ...identity, evidenceDigest: "5".repeat(64) },
        "engineering-quality",
      ),
    ).rejects.toThrow("does not match the trusted review");

    const complete = await writeLaneCheckpoint(
      sandbox.runtime,
      identity,
      "engineering-quality",
      {
        status: "complete",
        reviewedEntries: [0, 1],
        remainingEntries: [],
        observations: [],
        nextSteps: [],
        limitations: [],
        completedReport: completedLaneReport("engineering-quality"),
      },
      2,
    );
    expect(complete.schemaVersion).toBe(3);
    expect(complete.revision).toBe(2);
    await expect(
      writeLaneCheckpoint(
        sandbox.runtime,
        identity,
        "engineering-quality",
        {
          status: "in-progress",
          reviewedEntries: [],
          remainingEntries: [0, 1],
          observations: [],
          nextSteps: ["Start over."],
          limitations: [],
          completedReport: null,
        },
        2,
      ),
    ).rejects.toThrow("cannot be replaced");
  });

  test("binds a typed terminal report to its review axis", async () => {
    const sandbox = memorySandbox();
    await expect(
      writeLaneCheckpoint(
        sandbox.runtime,
        identity,
        "engineering-quality",
        {
          status: "complete",
          reviewedEntries: [0],
          remainingEntries: [],
          observations: [],
          nextSteps: [],
          limitations: [],
          completedReport: completedLaneReport("deduplication"),
        },
        1,
      ),
    ).rejects.toThrow("must match its checkpoint axis");
  });

  test("rejects legacy prose checkpoints after the schema-v3 hard cut", async () => {
    const sandbox = memorySandbox();
    sandbox.files.set(
      laneCheckpointPath(identity.patchFingerprint, "engineering-quality"),
      `${JSON.stringify({
        schemaVersion: 2,
        axis: "engineering-quality",
        ...identity,
        revision: 1,
        status: "complete",
        reviewedEntries: [0],
        remainingEntries: [],
        observations: [],
        nextSteps: [],
        limitations: [],
        completedReport: "Legacy prose report.",
      })}\n`,
    );
    await expect(
      readLaneCheckpoint(
        sandbox.runtime,
        identity,
        "engineering-quality",
      ),
    ).rejects.toThrow();
  });

  test("accepts a complete maximum-file checkpoint with a bounded typed report", async () => {
    const sandbox = memorySandbox();
    const reviewedEntries = Array.from({ length: 2_000 }, (_, index) => index);
    const checkpoint = await writeLaneCheckpoint(
      sandbox.runtime,
      identity,
      "deduplication",
      {
        status: "complete",
        reviewedEntries,
        remainingEntries: [],
        observations: [],
        nextSteps: [],
        limitations: [],
        completedReport: completedLaneReport("deduplication"),
      },
      2_000,
    );
    expect(checkpoint.reviewedEntries).toHaveLength(2_000);
  });
});
