import { z } from "zod";
import { githubAdapter } from "../github/chat-adapter";
import { checkName } from "../github/publication";
import { lifecycleRequest } from "./client";
const queueNoticeSchema = z.object({ deliveryId: z.string(), repositoryId: z.string(), repository: z.string(), pullRequest: z.number(), headSha: z.string(), installationId: z.number(), cancelled: z.boolean() });

export async function publishQueuedReviewNotices(): Promise<void> {
  const notices = queueNoticeSchema.array().parse(await lifecycleRequest("claimQueueNotices", {}));
  const results = await Promise.allSettled(notices.map(async notice => {
    let delivered = false;
    try {
      const [owner, repo] = notice.repository.split("/");
      if (!owner || !repo) throw new Error("Invalid queued repository");
      const octokit = githubAdapter(notice.installationId).octokit;
      const { data: liveRepository } = await octokit.rest.repos.get({ owner, repo });
      if (liveRepository.node_id !== notice.repositoryId) throw new Error("Queued repository identity changed");
      const marker = `slop-sheriff:queued:${notice.deliveryId}`;
      const checks = await octokit.paginate(octokit.rest.checks.listForRef, { owner, repo, ref: notice.headSha, check_name: checkName, per_page: 100 });
      const existing = checks.find(check => check.external_id === marker);
      if (notice.cancelled && existing && existing.status !== "completed") await octokit.rest.checks.update({ owner, repo, check_run_id: existing.id, status: "completed", conclusion: "cancelled", completed_at: new Date().toISOString(), output: { title: "Slop Sheriff: superseded", summary: "A newer review request replaced this queued request." }, request: { signal: AbortSignal.timeout(30_000) } });
      if (!notice.cancelled && !existing) await octokit.rest.checks.create({ owner, repo, name: checkName, head_sha: notice.headSha, external_id: marker, status: "queued", output: { title: "Slop Sheriff: queued for review", summary: "This review is durably queued. Available execution capacity is shared fairly across repositories; every selected review lane will run when this request is admitted." }, request: { signal: AbortSignal.timeout(30_000) } });
      delivered = true;
    } finally { await lifecycleRequest("finishQueueNotice", { deliveryId: notice.deliveryId, delivered, cancelled: notice.cancelled }); }
  }));
  for (const result of results) if (result.status === "rejected") console.error("Queued review status remains pending", result.reason instanceof Error ? result.reason.name : "unknown");
}

/** Retire only Checks carrying this exact retired attempt, never a replacement's same-SHA Check. */
export async function retireSupersededReviewChecks(job: import("./contracts").LifecycleJob): Promise<void> {
  if (!job.trustedContext) return;
  const context = (await import("../github/trusted-context")).trustedGitHubContextSchema.parse(JSON.parse(job.trustedContext));
  const octokit = githubAdapter(context.installationId).octokit;
  const { data: liveRepository } = await octokit.rest.repos.get({ owner: context.owner, repo: context.repo });
  if (liveRepository.node_id !== context.repositoryId) throw new Error("Retired repository identity changed");
  const checks = await octokit.paginate(octokit.rest.checks.listForRef, { owner: context.owner, repo: context.repo, ref: context.headSha, per_page: 100 });
  await Promise.all(checks.filter(check => check.status !== "completed" && check.external_id?.endsWith(`:${job.attemptId}`)).map(check => octokit.rest.checks.update({ owner: context.owner, repo: context.repo, check_run_id: check.id, status: "completed", conclusion: "cancelled", completed_at: new Date().toISOString(), output: { title: "Slop Sheriff: superseded", summary: "This exact review attempt was cancelled because a newer request owns the pull request." }, request: { signal: AbortSignal.timeout(30_000) } })));
}
