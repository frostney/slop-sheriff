import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { durableEvidenceReader } from "../src/review/durable-evidence";
import { durableProbeClaims, readWorkProbeReceipts, recordWorkProbeReceipt, runSharedReviewProbe } from "../src/review/probe-execution";
import { observeReviewSource, readWorkSourceObservations, recordWorkSourceObservation } from "../src/review/source-observations";
import type { TrustedGitHubContext } from "../src/github/trusted-context";

const modules = {
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/reviewLifecycle.ts": () => import("../convex/reviewLifecycle"),
  "../convex/artifactData.ts": () => import("../convex/artifactData"),
  "../convex/probeData.ts": () => import("../convex/probeData"),
  "../convex/http.ts": () => import("../convex/http"),
};
const admission = { deliveryId: "probe-delivery", repository: "owner/repo", repositoryId: "R_probe", pullRequest: 1, headSha: "a".repeat(40), eventTime: 1000, body: "{}", event: "pull_request", signature: "" };

test("Convex HTTP atomically owns one probe, rejects unauthorized/stale ownership and never steals a running claim", async () => {
  const original = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = "probe-offline-token";
  try {
    const t = convexTest(schema, modules);
    const post = (operation: string, body: unknown) => t.fetch(`/review-artifacts/probe-${operation}`, { method: "POST", headers: { authorization: "Bearer probe-offline-token", "content-type": "application/json" }, body: JSON.stringify(body) });
    await t.mutation(internal.reviewLifecycle.admit, admission);
    const [job] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 1 });
    const attemptId = job!.attemptId;
    const path = `/tmp/known-good-review/probes/${"b".repeat(64)}`;
    expect((await t.fetch("/review-artifacts/probe-claim", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await post("claim", { attemptId, path: `${path}/../escape`, owner: randomUUID() })).status).toBe(400);
    const results = await Promise.all(Array.from({ length: 8 }, async () => (await post("claim", { attemptId, path, owner: randomUUID() })).json() as Promise<{ acquired: boolean; owner: string }>));
    expect(results.filter(value => value.acquired)).toHaveLength(1);
    expect(new Set(results.map(value => value.owner)).size).toBe(1);
    await expect(post("release", { attemptId, path, owner: randomUUID() })).rejects.toThrow("another execution");
    const owner = results[0]!.owner;
    expect(await (await post("claim", { attemptId, path, owner: randomUUID() })).json()).toEqual({ acquired: false, owner });
    expect((await post("release", { attemptId, path, owner })).status).toBe(200);
    const next = await (await post("claim", { attemptId, path, owner: randomUUID() })).json() as { acquired: boolean; owner: string };
    expect(next.acquired).toBe(true);
    await post("fail", { attemptId, path, owner: next.owner });
    await expect(post("assert-healthy", { attemptId, path, owner: next.owner })).rejects.toThrow("outcome is unknown");
    expect(await (await post("claim", { attemptId, path, owner: randomUUID() })).json()).toEqual({ acquired: false, owner: next.owner });
    await t.mutation(internal.reviewLifecycle.admit, { ...admission, deliveryId: "new-head", headSha: "c".repeat(40), eventTime: 2000 });
    await expect(post("claim", { attemptId, path, owner: randomUUID() })).rejects.toThrow("no longer owns");
    await expect(post("release", { attemptId, path, owner: next.owner })).rejects.toThrow("no longer owns");
    await expect(post("assert-current", { attemptId })).rejects.toThrow("no longer owns");
  } finally {
    if (original === undefined) delete process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
    else process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = original;
  }
});

test("independent application executors share an authenticated durable receipt through real Convex HTTP", async () => {
  const original = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = "probe-offline-token";
  try {
    const t = convexTest(schema, modules);
    await t.mutation(internal.reviewLifecycle.admit, admission);
    const [job] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 1 });
    const context: TrustedGitHubContext = {
      installationId: 1, deliveryId: job!.attemptId, repositoryId: admission.repositoryId,
      owner: "owner", repo: "repo", repository: admission.repository, pullRequest: 1,
      repositoryDatabaseId: 1, repositoryCreatedAt: 0, baseSha: "d".repeat(40), headSha: admission.headSha,
      patchFingerprint: "e".repeat(64), reviewPolicyDigest: "f".repeat(64),
    };
    const request = async (operation: string, body: unknown): Promise<unknown> => {
      const response = await t.fetch(`/review-artifacts/${operation}`, { method: "POST", headers: { authorization: "Bearer probe-offline-token", "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`fixture HTTP ${response.status}`);
      return response.json();
    };
    const dependencies = { request, secret: "ab".repeat(32), inspect: async () => job! };
    let executions = 0;
    const executor = (sessionId: string) => ({
      repositoryId: context.repositoryId,
      origin: { attemptId: job!.attemptId, sessionId, callId: randomUUID() },
      evidence: durableEvidenceReader(context, "root", dependencies),
      claims: durableProbeClaims(job!.attemptId, request),
      observe: async () => ({ sourceDigest: "1".repeat(64), environmentDigest: "2".repeat(64), externalStateDigest: null, reuse: "same-snapshot" as const }),
      execute: async () => {
        executions += 1;
        const process = Bun.spawn(["/bin/bash", "-c", "sleep 0.03; printf 'actual offline probe'"], { stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
        return { exitCode, stdout, stderr };
      },
    });
    const input = { command: "bun test", cwd: ".", stdin: null, environment: [], rerun: false };
    const [first, second] = await Promise.all([runSharedReviewProbe(input, executor("one")), runSharedReviewProbe(input, executor("two"))]);
    const resumed = await runSharedReviewProbe(input, executor("new-native-worker"));
    expect(executions).toBe(1);
    expect(first.receipt.result?.stdout).toBe("actual offline probe");
    expect(first.receipt.digest).toBe(second.receipt.digest);
    expect(resumed.receipt.digest).toBe(first.receipt.digest);
    expect(resumed.reused).toBe(true);
    const stored = await t.run(ctx => ctx.db.query("reviewArtifacts").collect());
    expect(stored).toHaveLength(2);

    const workId = "7".repeat(64);
    const alternate = await runSharedReviewProbe({ ...input, command: "bun test scenario-two" }, executor("three"));
    await Promise.all([first, alternate, first].map(async ({ receipt }) => {
      const worker = executor(randomUUID());
      await recordWorkProbeReceipt(worker.evidence, worker.claims, context.patchFingerprint!, workId, receipt);
    }));
    expect((await readWorkProbeReceipts(executor("reader").evidence, context.patchFingerprint!, workId)).map(receipt => receipt.executionId).sort()).toEqual([first.receipt.executionId, alternate.receipt.executionId].sort());

    const sourceSandbox = { async run({ command }: { command: string }) {
      const child = Bun.spawn(["/bin/bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { exitCode, stdout, stderr };
    } };
    const revision = (await sourceSandbox.run({ command: "git rev-parse HEAD" })).stdout.trim();
    const observations = await Promise.all(["package.json", "README.md"].map(path => observeReviewSource(sourceSandbox, { baseSha: revision, headSha: revision }, { operation: "read", revision: "head", path, query: null, cursor: null }, process.cwd())));
    await Promise.all([...observations, observations[0]!].map(async observation => {
      const worker = executor(randomUUID());
      await recordWorkSourceObservation(worker.evidence, worker.claims, context.patchFingerprint!, workId, observation);
    }));
    expect((await readWorkSourceObservations(executor("source-reader").evidence, context.patchFingerprint!, workId)).map(observation => observation.id).sort()).toEqual(observations.map(observation => observation.id).sort());
  } finally {
    if (original === undefined) delete process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
    else process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = original;
  }
});
