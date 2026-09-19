import { readCostReport } from "../src/telemetry/cost-client";
const [repositoryId, rawPullRequest] = process.argv.slice(2);
const pullRequest = Number(rawPullRequest);
if (!repositoryId || !Number.isInteger(pullRequest) || pullRequest <= 0) {
  throw new Error("Usage: bun scripts/review-costs.ts <repository-node-id> <pull-request-number>");
}
console.log(JSON.stringify(await readCostReport(repositoryId, pullRequest), null, 2));
