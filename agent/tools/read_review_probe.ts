import { defineTool } from "eve/tools";
import { z } from "zod";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { getReviewEvidenceSandbox } from "../lib/evidence-sandbox";
import { reviewRouteState } from "../lib/review-route";
import { durableProbeClaims, readWorkProbeReceipts, reviewProbeReceiptPath, reviewProbeReceiptSchema, reviewProbeOutputPage } from "../../src/review/probe-execution";
export const readReviewProbeInputSchema = z.strictObject({ probeId: z.string().regex(/^[a-f0-9]{64}$/), executionId: z.string().uuid(), stream: z.enum(["stdout", "stderr"]), cursor: z.number().int().nonnegative().nullable() });
export default defineTool({
  description: "Read another page of a completed probe's full stdout or stderr without rerunning it. Keep following nextCursor until null when full output matters. The receipt records the execution once regardless of how many pages are read.",
  inputSchema: readReviewProbeInputSchema,
  async execute(input, ctx) {
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.deliveryId || !trusted.patchFingerprint) throw new Error("Probe output requires an admitted review attempt");
    const sandbox = await getReviewEvidenceSandbox(ctx);
    const claims = durableProbeClaims(trusted.deliveryId);
    await claims.assertCurrent();
    const raw = await sandbox.readTextFile({ path: reviewProbeReceiptPath(input.probeId, input.executionId) });
    if (raw === null) throw new Error("Probe receipt does not exist");
    const receipt = reviewProbeReceiptSchema.parse(JSON.parse(raw));
    const route = reviewRouteState.get();
    if (route?.role === "lane" && route.workId && !(await readWorkProbeReceipts(sandbox, trusted.patchFingerprint, route.workId)).some(item => item.digest === receipt.digest)) throw new Error("Probe output was not consumed by this work unit");
    await claims.assertCurrent();
    return reviewProbeOutputPage(receipt, input.stream, input.cursor);
  },
});
