import type { ToolContext } from "eve/tools";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { preparedReviewWorkPlanSchema } from "../../src/review/prepare-review-work";
import { reviewWorkPlanPath } from "../../src/review/work-plan";
import { durableProbeClaims } from "../../src/review/probe-execution";
import { getReviewEvidenceSandbox } from "./evidence-sandbox";
import { reviewRouteState } from "./review-route";

export async function assignedReviewWorkContext(ctx: ToolContext) {
  const trusted = trustedGitHubContext(ctx.session.auth.current);
  const route = reviewRouteState.get();
  if (!trusted.deliveryId || !trusted.patchFingerprint || route?.role !== "lane" || !route.workId) throw new Error("Tracked observations require an assigned review work unit");
  const sandbox = await getReviewEvidenceSandbox(ctx);
  const plan = preparedReviewWorkPlanSchema.parse(JSON.parse(await sandbox.readTextFile({ path: reviewWorkPlanPath(trusted.patchFingerprint) }) ?? "null"));
  if (plan.baseSha !== trusted.baseSha || plan.headSha !== trusted.headSha || !plan.units.some(unit => unit.id === route.workId && unit.axis === route.axis)) throw new Error("Observation assignment does not match the current prepared review plan");
  const claims = durableProbeClaims(trusted.deliveryId);
  await claims.assertCurrent();
  return { sandbox, claims, identity: { fingerprint: trusted.patchFingerprint, workId: route.workId, attemptId: trusted.deliveryId } };
}
