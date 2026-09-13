import { defineHook } from "eve/hooks";
import { admitNativeReviewWork } from "../../../../../agent/lib/review-workflow";
import { fixtureWorkReader } from "../lib/work-fixture";
import { identity } from "../lib/orchestration";
export default defineHook({ events: { async "turn.started"(_event,ctx) {
  const parent = ctx.session.parent;
  if (!parent || !/:work:[a-f0-9]{64}:\d+$/.test(parent.callId)) return;
  await admitNativeReviewWork(fixtureWorkReader(parent.rootSessionId), identity.patchFingerprint, { rootSessionId: parent.rootSessionId, invocationId: parent.callId, sessionId: ctx.session.id });
} } });
