import { refreshReviewWorkNativeHandles, waitForNativeWorkInvocation } from "../lib/native-work-handles";
import { expectedNativeWorkInvocation } from "../lib/review-workflow";
import { assignedReviewWorkOnly } from "../lib/review-capabilities";
import { defineTool, toolOutput } from "eve/tools";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { getReviewEvidenceSandbox } from "../lib/evidence-sandbox";
import { reviewRouteState } from "../lib/review-route";
import { currentReviewEvidenceIdentity } from "../lib/review-evidence";
import { reviewWorkPlanPath } from "../../src/review/work-plan";
import { preparedReviewWorkPacketSchema, preparedReviewWorkPlanSchema, preparedReviewWorkPacketPath, captureReviewWorkProof, validateCurrentReviewWorkProof } from "../../src/review/prepare-review-work";
import { readCapabilityPreflight } from "../../src/review/capability-preflight";
import { completedReviewWorkStore } from "../../src/review/work-storage";
import { durableProbeClaims, withReviewEvidenceLock } from "../../src/review/probe-execution";
import { reviewWorkInputSchema, reviewWorkContext, persistReviewWork } from "../../src/review/work-execution";
import { reviewWorkResultArtifactSchema } from "../../src/review/work-runtime";

export { reviewWorkInputSchema } from "../../src/review/work-execution";

export const reviewTool = defineTool({
  description: "Read your assigned component or requirement assessment, or persist its progress/completion. The application supplies all identities, validates exact coverage and records source/test dependencies. Read first. Preserve useful evidence across interruptions. On completion call final_output with the returned workId and status. Never copy signatures or source receipts into your report.",
  inputSchema: reviewWorkInputSchema,
  async execute(input, ctx) {
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    const route = reviewRouteState.get();
    const parent = ctx.session.parent;
    if (!parent || !trusted.deliveryId || !trusted.patchFingerprint || route?.role !== "lane" || !route.workId) throw new Error("Review work requires an application-assigned native child");
    const sandbox = await getReviewEvidenceSandbox(ctx);
    const plan = preparedReviewWorkPlanSchema.parse(JSON.parse(await sandbox.readTextFile({ path: reviewWorkPlanPath(trusted.patchFingerprint) }) ?? "null"));
    const assigned = plan.units.find(unit => unit.id === route.workId && unit.axis === route.axis);
    if (!assigned || plan.baseSha !== trusted.baseSha || plan.headSha !== trusted.headSha || plan.patchFingerprint !== trusted.patchFingerprint || assigned.packetPath !== preparedReviewWorkPacketPath(plan.patchFingerprint, assigned.id)) throw new Error("Work assignment does not match the current prepared plan");
    const packet = preparedReviewWorkPacketSchema.parse(JSON.parse(await sandbox.readTextFile({ path: assigned.packetPath }) ?? "null"));
    if (packet.unit.id !== assigned.id || packet.inputDigest !== assigned.inputDigest) throw new Error("Prepared work packet does not match assignment");
    const claims = durableProbeClaims(trusted.deliveryId);
    await claims.assertCurrent();
    if (input.operation === "read") {
      const saved = await sandbox.readTextFile({ path: assigned.resultPath });
      const parsed = saved === null ? null : reviewWorkResultArtifactSchema.safeParse(JSON.parse(saved));
      const result = parsed?.success && parsed.data.attemptId === trusted.deliveryId ? parsed.data : null;
      if (result && (result.assessment.unit.id !== assigned.id || result.assessment.inputDigest !== assigned.inputDigest || result.invocation.rootSessionId !== parent.rootSessionId)) throw new Error("Saved work progress belongs to another assignment");
      return { operation: "read" as const, context: reviewWorkContext(result ? { ...packet, priorAssessment: result.assessment, reuseInvalidation: "Continue the current saved assessment." } : packet) };
    }
    if (!input.checkpoint) throw new Error("Work writes require a checkpoint");
    const capabilities = await readCapabilityPreflight(sandbox, currentReviewEvidenceIdentity(ctx.session.auth.current));
    const expectedInvocationId = await expectedNativeWorkInvocation(sandbox, trusted.patchFingerprint, {
      rootSessionId: parent.rootSessionId, sessionId: ctx.session.id, initialInvocationId: parent.callId });
    const invocation = await waitForNativeWorkInvocation({ rootSessionId: parent.rootSessionId, sessionId: ctx.session.id,
      invocationId: expectedInvocationId, signal: ctx.abortSignal,
      refresh: () => refreshReviewWorkNativeHandles(ctx.session.auth.current, parent.rootSessionId, ctx.abortSignal) });
    const receipt = await withReviewEvidenceLock(claims, ["work-result", trusted.patchFingerprint, assigned.id], async () => {
      const proof = await captureReviewWorkProof(sandbox, trusted.patchFingerprint!, packet.unit, packet.inputSnapshot, trusted.deliveryId!);
      return persistReviewWork({ packet, checkpoint: input.checkpoint!, proof, escalation: input.escalation,
        attemptId: trusted.deliveryId!, assertCurrent: () => claims.assertCurrent(),
        invocation: { rootSessionId: parent.rootSessionId, invocationId: invocation.invocationId, sessionId: ctx.session.id, turnId: ctx.session.turn.id },
        evidence: sandbox, store: completedReviewWorkStore(trusted),
        validateProof: assessment => validateCurrentReviewWorkProof(sandbox, { ...trusted, patchFingerprint: plan.patchFingerprint }, capabilities.setup, assessment, packet.inputSnapshot, trusted.deliveryId!),
      });
    }, ctx.abortSignal);
    return { operation: "write" as const, receipt };
  },
  toModelOutput(output) { return toolOutput.json(output.operation === "read" ? output.context : output.receipt); },
});

export default assignedReviewWorkOnly(reviewTool);
