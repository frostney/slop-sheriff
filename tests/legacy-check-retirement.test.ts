import { expect, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import { retireLegacyReviewChecks } from "../src/lifecycle/legacy-checks";
import type { TrustedGitHubContext } from "../src/github/trusted-context";

test("new durable admission retires eight older owned Checks and leaves unrelated or replacement Checks untouched", async () => {
  const writes: number[] = [];
  const oldChecks = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, name: index ? `known-good-review / lane-${index}` : "known-good-review", status: "in_progress", external_id: index ? `known-good-review / lane-${index}:43:old-head` : "known-good-review:43:base:old-head:full:initial:old-attempt", app: { id: 123 } }));
  const old = [...oldChecks, { ...oldChecks[0], id: 90, app: { id: 999 } }, { ...oldChecks[0], id: 91, external_id: "known-good-review:44:base:old-head:full:initial:unrelated" }, { ...oldChecks[0], id: 92, name: "Unrelated checks", external_id: "unrelated:43:old-head" }];
  const octokit = new Octokit({ request: { fetch: async (url: Request | URL | string, init?: RequestInit) => {
    if (init?.method === "PATCH") { writes.push(Number(String(url).split("/").at(-1))); return Response.json({}); }
    const response = Response.json({ total_count: 11, check_runs: String(url).includes("new-head") ? [{ id: 100, name: "slop-sheriff", status: "in_progress", external_id: "known-good-review:43:base:new-head:full:initial:new-attempt", app: { id: 123 } }] : old });
    Object.defineProperty(response, "url", { value: String(url) });
    return response;
  } } });
  const context = { deliveryId: "new-attempt", owner: "acme", repo: "repo", repository: "acme/repo", pullRequest: 43, headSha: "new-head" } as TrustedGitHubContext;
  expect(await retireLegacyReviewChecks({ context, octokit, previousHead: "old-head" })).toBe(8);
  expect(writes.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});


test("legacy failure without a saved current head discovers PR commits and retires only owned unfinished checks", async () => {
  const writes: number[] = [];
  const reads: string[] = [];
  const octokit = new Octokit({ request: { fetch: async (url: Request | URL | string, init?: RequestInit) => {
    const path = String(url); reads.push(path);
    if (init?.method === "PATCH") { writes.push(Number(path.split("/").at(-1))); return Response.json({}); }
    let data: unknown;
    if (path.includes("/pulls/43/commits")) data = [{ sha: "base" }, { sha: "lost-head" }, { sha: "new-head" }];
    else if (path.includes("new-head")) data = { total_count: 1, check_runs: [{ id: 100, name: "slop-sheriff", status: "in_progress", external_id: "known-good-review:43:base:new-head:full:initial:new-attempt", app: { id: 123 } }] };
    else if (path.includes("lost-head")) data = { total_count: 3, check_runs: [
      { id: 1, name: "slop-sheriff", status: "in_progress", external_id: "known-good-review:43:base:lost-head:full:manual", app: { id: 123 } },
      { id: 2, name: "slop-sheriff / test-health", status: "in_progress", external_id: "slop-sheriff / test-health:43:lost-head", app: { id: 123 } },
      { id: 3, name: "slop-sheriff", status: "in_progress", external_id: "known-good-review:44:base:lost-head:full:manual", app: { id: 123 } },
    ] };
    else data = { total_count: 0, check_runs: [] };
    const response = Response.json(data); Object.defineProperty(response, "url", { value: path }); return response;
  } } });
  const context = { deliveryId: "new-attempt", owner: "acme", repo: "repo", repository: "acme/repo", pullRequest: 43, headSha: "new-head" } as TrustedGitHubContext;
  expect(await retireLegacyReviewChecks({ context, octokit, discoverLegacyHeads: true })).toBe(2);
  expect(writes).toEqual([1, 2]);
  expect(reads.filter(path => path.includes("/pulls/43/commits"))).toHaveLength(1);
});
