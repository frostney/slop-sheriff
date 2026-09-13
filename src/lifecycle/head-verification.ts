import { githubAdapter } from "../github/chat-adapter";
import { lifecycleAdmissionSchema } from "./contracts";
import { lifecycleRequest } from "./client";
import { z } from "zod";

/** Equal-resolution webhook timestamps cannot determine which different head is newest. */
export async function verifyAmbiguousReviewHeads(): Promise<void> {
  const rows = lifecycleAdmissionSchema.array().parse(await lifecycleRequest("claimHeadVerifications", {}));
  await Promise.all(rows.map(async row => {
    let currentHead: string | null = null;
    try {
      const raw = z.object({ installation: z.object({ id: z.number() }) }).parse(JSON.parse(row.body));
      const [owner, repo] = row.repository.split("/");
      if (!owner || !repo) throw new Error("Invalid repository");
      const octokit = githubAdapter(raw.installation.id).octokit;
      const { data: repository } = await octokit.rest.repos.get({ owner, repo });
      if (repository.node_id !== row.repositoryId) currentHead = "repository-identity-changed";
      else currentHead = (await octokit.rest.pulls.get({ owner, repo, pull_number: row.pullRequest })).data.head.sha;
    } catch { /* Keep the admitted obligation pending when read-only verification is unavailable. */ }
    await lifecycleRequest("verifyHead", { deliveryId: row.deliveryId, currentHead });
  }));
}
