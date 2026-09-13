import type { Octokit } from "@octokit/rest";
import type { TrustedGitHubContext } from "../github/trusted-context";
import { fencePublicationWrites } from "./publication-fence";

/** Adopt only this application's older PR/head Check identities into cancellation. */
export async function retireLegacyReviewChecks(input: { context: TrustedGitHubContext; octokit: Octokit; previousHead?: string }): Promise<number> {
  const { context } = input;
  if (!context.deliveryId) return 0;
  const octokit = fencePublicationWrites(input.octokit, context);
  const current = await octokit.paginate(octokit.rest.checks.listForRef, { owner: context.owner, repo: context.repo, ref: context.headSha, per_page: 100 });
  const currentAttempt = current.find(check => check.external_id?.endsWith(`:${context.deliveryId}`));
  const appId = currentAttempt?.app?.id;
  if (!appId) return 0;
  const head = input.previousHead ?? context.headSha;
  const previous = head === context.headSha ? current : await octokit.paginate(octokit.rest.checks.listForRef, { owner: context.owner, repo: context.repo, ref: head, per_page: 100 });
  const selected = previous.filter(check => {
    const identity = check.external_id?.split(":") ?? [];
    return check.status !== "completed" && check.app?.id === appId &&
      /^(?:slop-sheriff|known-good-review)(?: \/|$)/.test(check.name) &&
      identity[1] === String(context.pullRequest) && identity.includes(head) &&
      !check.external_id?.endsWith(`:${context.deliveryId}`);
  });
  await Promise.all(selected.map(check => octokit.rest.checks.update({ owner: context.owner, repo: context.repo, check_run_id: check.id, status: "completed", conclusion: "cancelled", completed_at: new Date().toISOString(), output: { title: "Slop Sheriff: older attempt retired", summary: "This older review attempt was superseded by a newly admitted durable review. Its incomplete result grants no merge clearance." } })));
  return selected.length;
}
