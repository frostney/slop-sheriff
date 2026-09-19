import { defineTool } from "eve/tools";
import { z } from "zod";
import { reviewRouteState } from "../../../../../agent/lib/review-route";
import { identity, checkpointContent } from "../lib/orchestration";
import { fixtureWorkReader, refreshFixtureWorkHandles } from "../lib/work-fixture";
import { preparedReviewWorkPlanSchema, preparedReviewWorkPacketSchema } from "../../../../../src/review/prepare-review-work";
import { reviewWorkPlanPath } from "../../../../../src/review/work-plan";
import { reviewWorkResultArtifactSchema } from "../../../../../src/review/work-runtime";
import { expectedNativeWorkInvocation } from "../../../../../agent/lib/review-workflow";
import { waitForNativeWorkInvocation } from "../../../../../agent/lib/native-work-handles";
export default defineTool({ description: "Write an application-signed synthetic component result.", inputSchema: z.strictObject({}),
  async execute(_input, ctx) {
    const route = reviewRouteState.get();
    if (route?.role !== "lane" || !route.workId || !ctx.session.parent) throw new Error("Expected assigned native work");
    const reader = fixtureWorkReader(ctx.session.parent.rootSessionId);
    const plan = preparedReviewWorkPlanSchema.parse(JSON.parse((await reader.readTextFile({ path: reviewWorkPlanPath(identity.patchFingerprint) }))!));
    const unit = plan.units.find(unit => unit.id === route.workId)!;
    const packet = preparedReviewWorkPacketSchema.parse(JSON.parse((await reader.readTextFile({ path: unit.packetPath }))!));
    const prior = await reader.readTextFile({ path: unit.resultPath });
    const incomplete = route.axis === "engineering-quality" && prior === null;
    const invocationId = await expectedNativeWorkInvocation(reader, identity.patchFingerprint, {
      rootSessionId: ctx.session.parent.rootSessionId, sessionId: ctx.session.id, initialInvocationId: ctx.session.parent.callId });
    const handle = await waitForNativeWorkInvocation({ rootSessionId: ctx.session.parent.rootSessionId, sessionId: ctx.session.id,
      invocationId, signal: ctx.abortSignal, refresh: () => refreshFixtureWorkHandles(ctx.session.parent!.rootSessionId, ctx.abortSignal) });
    const result = reviewWorkResultArtifactSchema.parse({ schemaVersion:2, attemptId:"fixture-attempt", assessment: { schemaVersion: 1, unit: packet.unit, inputDigest: packet.inputDigest, sourceBaseSha: identity.baseSha, sourceHeadSha: identity.headSha, proof: { schemaVersion: 2, inputSnapshot: packet.inputSnapshot, sources: [], probes: [], external: [] }, checkpoint: checkpointContent(route.axis, incomplete) }, invocation: { rootSessionId: handle.rootSessionId, invocationId: handle.invocationId, sessionId: ctx.session.id, turnId: ctx.session.turn.id } });
    await reader.writeTextFile({ path: unit.resultPath, content: JSON.stringify(result) });
    return { workId: unit.id, status: result.assessment.checkpoint.status, parentCallId: ctx.session.parent.callId, nativeInvocationId: handle.invocationId, sessionId: ctx.session.id };
  },
});
