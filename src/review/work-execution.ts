import { z } from "zod";
import { reviewExecutionReferencesSchema } from "./execution-reference";
import type { TextSandbox } from "./authenticated-evidence";
import { laneCheckpointDraftContentSchema } from "./lane-checkpoint";
import { preparedReviewWorkPacketSchema, type PreparedReviewWorkPacket } from "./prepare-review-work";
import { requirementObligationIdentities } from "./requirements";
import { reviewWorkAssessmentSchema, validateWorkAssessment, workAssessmentStorageKey, type ReviewWorkAssessment } from "./work-results";
import { reviewWorkEscalationSchema, reviewWorkResultArtifactSchema, reviewWorkResultPath } from "./work-runtime";

const legacyWorkReport = laneCheckpointDraftContentSchema.shape.completedReport.unwrap();
const references = reviewExecutionReferencesSchema.describe("Actual consumed evidence: probe executionId from run_review_probe or external observationId from a tracked reference/image tool. Empty only for source-only or inapplicable checks; never invent identifiers.");
export const reviewWorkCheckpointDraftSchema = laneCheckpointDraftContentSchema.safeExtend({
  completedReport: legacyWorkReport.safeExtend({
    candidates: z.array(legacyWorkReport.shape.candidates.element.extend({ evidenceRefs: references })),
    probes: z.array(legacyWorkReport.shape.probes.element.extend({ evidenceRefs: references })),
    specialistChecks: z.array(legacyWorkReport.shape.specialistChecks.unwrap().element.extend({ evidenceRefs: references })).nullable(),
    requirementChecks: z.array(legacyWorkReport.shape.requirementChecks.unwrap().element.extend({ evidenceRefs: references })).nullable(),
  }).nullable(),
});

// The wire contract expresses operation variants instead of relying on invisible
// cross-field refinements. The application owns terminal checkpoint bookkeeping.
const completedReport = reviewWorkCheckpointDraftSchema.shape.completedReport.unwrap();
const modelReport = completedReport.safeExtend({
  // Presentation is produced by adjudication, not by the technical investigator.
  candidates: z.array(completedReport.shape.candidates.element.omit({ introduction: true, principle: true, risk: true })),
});
const checkpointFields = reviewWorkCheckpointDraftSchema.shape;
export const reviewWorkInputSchema = z.strictObject({
  action: z.union([
    z.strictObject({ operation: z.literal("read") }),
    z.strictObject({
      operation: z.literal("progress"),
      reviewedEntries: checkpointFields.reviewedEntries,
      remainingEntries: checkpointFields.remainingEntries,
      observations: checkpointFields.observations,
      nextSteps: checkpointFields.nextSteps,
      limitations: checkpointFields.limitations,
      escalation: reviewWorkEscalationSchema.nullable().describe("Stronger reasoning for unresolved technical ambiguity or conflicting evidence, or null. Missing setup must be repaired."),
    }),
    z.strictObject({
      operation: z.literal("complete"),
      reviewedEntries: checkpointFields.reviewedEntries,
      report: modelReport.describe("The complete technical assessment. Required even when no findings exist. Put terminal limitations here."),
    }),
  ]),
});

export function reviewWorkCheckpoint(action: Exclude<z.infer<typeof reviewWorkInputSchema>["action"], { operation: "read" }>) {
  if (action.operation === "complete") return {
    checkpoint: reviewWorkCheckpointDraftSchema.parse({ status: "complete", reviewedEntries: action.reviewedEntries,
      remainingEntries: [], observations: [], nextSteps: [], limitations: [], completedReport: action.report }),
    escalation: null,
  };
  const { operation: _operation, escalation, ...progress } = action;
  return { checkpoint: reviewWorkCheckpointDraftSchema.parse({ ...progress, status: "in-progress", completedReport: null }), escalation };
}

/** Only investigation context enters the model. Signatures, dependency receipts,
 * storage keys and source histories remain application-owned. */
export function reviewWorkContext(raw: PreparedReviewWorkPacket) {
  const packet = preparedReviewWorkPacketSchema.parse(raw);
  return {
    workId: packet.unit.id, axis: packet.unit.axis, component: packet.unit.component,
    claim: packet.originalClaim,
    entries: packet.manifest.entries.map((entry, index) => ({ index, path: entry.path, status: entry.status, kind: entry.kind })),
    requirements: packet.requirements.map(({ source, baseText, headText }) => {
      // The dedicated requirement assessment receives the full written context.
      // Technical/test specialists start from frozen clauses and source locations;
      // they inspect surrounding text when needed instead of receiving every
      // linked manual repeatedly. The signed packet still retains the full text.
      const fullText = packet.unit.axis === "claim-and-specification" || source.kind === "lane-criteria";
      return { id: source.id, path: source.path, kind: source.kind, obligations: source.obligations,
        baseText: fullText ? baseText : null, headText: fullText && headText !== baseText ? headText : null,
        identicalRevisions: headText === baseText,
        sourceText: fullText ? "included" : "Use inspect_review_source at the supplied base/head path for surrounding context or implicit requirements.",
      };
    }),
    // Requirement assessment begins with the specification. Shipping every PR
    // patch once per document would recreate the previous repeated full review.
    // Exact source and update patches remain available through recorded tools.
    patches: packet.unit.component.startsWith("requirement:") ? [] : packet.patches,
    prior: packet.priorAssessment ? {
      sourceHeadSha: packet.priorAssessment.sourceHeadSha,
      checkpoint: packet.priorAssessment.checkpoint,
      invalidation: packet.reuseInvalidation,
    } : null,
  };
}

export async function persistReviewWork(input: {
  packet: PreparedReviewWorkPacket;
  checkpoint: z.infer<typeof reviewWorkCheckpointDraftSchema>;
  proof: unknown;
  attemptId: string;
  assertCurrent(): Promise<void>;
  invocation: z.infer<typeof reviewWorkResultArtifactSchema>["invocation"];
  escalation?: z.infer<typeof reviewWorkEscalationSchema> | null | undefined;
  evidence: TextSandbox;
  validateProof(assessment: ReviewWorkAssessment): Promise<boolean>;
  store: { put(input: { scopeKey: string; inputDigest: string; data: string }): Promise<unknown> };
}): Promise<{ workId: string; status: "complete" | "in-progress" }> {
  const attemptId = z.string().min(1).parse(input.attemptId);
  await input.assertCurrent();
  const packet = preparedReviewWorkPacketSchema.parse(input.packet);
  if (input.escalation && input.checkpoint.status !== "in-progress") throw new Error("Only unfinished work can request reasoning escalation");
  const assessment = await validateWorkAssessment({ schemaVersion: 1, unit: packet.unit,
    inputDigest: packet.inputDigest, sourceBaseSha: packet.manifest.baseSha, sourceHeadSha: packet.manifest.headSha,
    proof: input.proof, checkpoint: reviewWorkCheckpointDraftSchema.parse(input.checkpoint),
  }, packet.unit, { inputDigest: packet.inputDigest,
    obligations: requirementObligationIdentities(packet.requirements.map(item => item.source)),
    validateProof: input.validateProof,
  });
  for (const candidate of assessment.checkpoint.completedReport?.candidates ?? []) {
    if (!packet.unit.paths.includes(candidate.location.path)) throw new Error("Work finding expands its assigned file scope");
  }
  const path = reviewWorkResultPath(packet.manifest.patchFingerprint, packet.unit.id);
  const prior = await input.evidence.readTextFile({ path });
  if (prior !== null) {
    const existing = reviewWorkResultArtifactSchema.safeParse(JSON.parse(prior));
    // Old or unversioned results cannot establish this attempt's completion.
    if (existing.success && existing.data.attemptId === attemptId) {
      if (existing.data.assessment.inputDigest !== packet.inputDigest) throw new Error("Current work result has a different input identity");
      if (existing.data.assessment.checkpoint.status === "complete" && JSON.stringify(existing.data.assessment) !== JSON.stringify(assessment)) throw new Error("Completed work is immutable; a second completion cannot replace its evidence");
    }
  }
  // Store before acknowledging completion. A publication or root failure cannot
  // discard a unit that has already finished. Unknown outcomes retry idempotently.
  await input.store.put({ ...workAssessmentStorageKey(assessment), data: JSON.stringify(reviewWorkAssessmentSchema.parse(assessment)) });
  await input.assertCurrent();
  const artifact = reviewWorkResultArtifactSchema.parse({ schemaVersion: 2, attemptId, assessment, invocation: input.invocation, escalation: input.escalation ?? null });
  await input.evidence.writeTextFile({ path, content: JSON.stringify(artifact) });
  return { workId: packet.unit.id, status: assessment.checkpoint.status };
}
