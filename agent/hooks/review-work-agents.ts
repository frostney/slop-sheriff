import { defineHook } from "eve/hooks";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { getDurableReviewEvidenceReader } from "../lib/evidence-sandbox";
import { admitNativeReviewWork } from "../lib/review-workflow";

/** Native ctx.agent bypasses subagent.called hooks. A child turn admission is
 * an awaited boundary and fences a child created after the cancellation scan. */
export default defineHook({ events: {
  async "turn.started"(_event, ctx) {
    const parent = ctx.session.parent;
    if (!parent) return;
    const match = /^(.+):work:([a-f0-9]{64}):\d+$/.exec(parent.callId);
    if (!match) return;
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.patchFingerprint) throw new Error("Native work admission lacks prepared identity");
    const reader = getDurableReviewEvidenceReader(ctx.session.auth.current, parent.rootSessionId);
    if (!reader) throw new Error("Native work admission requires durable evidence storage");
    await admitNativeReviewWork(reader, trusted.patchFingerprint, { rootSessionId: parent.rootSessionId, invocationId: parent.callId, sessionId: ctx.session.id });
  },
} });
