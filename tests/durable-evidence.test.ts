import { expect, spyOn, test } from "bun:test";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { artifactBinding, artifactEligibility, authenticateArtifact, durableEvidenceReader, envelopeForArtifact } from "../src/review/durable-evidence";
import type { ArtifactEnvelope } from "../src/review/durable-evidence-contracts";
import type { TrustedGitHubContext } from "../src/github/trusted-context";
import { getReviewEvidenceSandbox } from "../agent/lib/evidence-sandbox";
import type { SessionContext } from "eve/context";
import { withTrustedReviewContext } from "../src/github/trusted-context";
import { authenticatedEvidenceSandbox } from "../src/review/authenticated-evidence";
import type { LifecycleJob } from "../src/lifecycle/contracts";
import { assembleReviewEvidenceLedger, reviewEvidenceLedgerPath } from "../src/review/evidence-ledger";
import { prepareExactHeadGitHubEvidence } from "../src/review/github-evidence";
import { commonWorkFixture } from "./common-work-fixture";
import { checkpointContent } from "./fixtures/eve-runtime-smoke/agent/lib/orchestration";
const secret = "ab".repeat(32);
const context: TrustedGitHubContext = { installationId: 1, deliveryId: "new-attempt", owner: "owner", repo: "repo", repository: "owner/repo", repositoryId: "R_test", repositoryDatabaseId: 1, repositoryCreatedAt: 0, pullRequest: 43, baseSha: "a".repeat(40), headSha: "b".repeat(40), patchFingerprint: "c".repeat(64), reviewPolicyDigest: "d".repeat(64) };
const path = `/tmp/known-good-review/evidence/${context.patchFingerprint}/manifest.json`;
function storeFixture() {
  const store = new Map<string, ArtifactEnvelope>();
  const writes: ArtifactEnvelope[] = [];
  return { store, writes, async request(operation: string, body: unknown): Promise<unknown> {
    const args = body as { attemptId: string; path: string } & ArtifactEnvelope;
    if (operation === "metadata") return [...store.values()].find(row => row.binding.attemptId === args.attemptId) ?? null;
    if (operation === "get") return store.get(`${args.attemptId}:${args.path}`) ?? null;
    if (operation === "list") return { page: [...store.values()].filter(row => row.binding.attemptId === args.attemptId).map(row => ({ path: row.path })), isDone: true, continueCursor: "" };
    if (operation === "put") { writes.push(args); store.set(`${args.binding.attemptId}:${args.path}`, args); return { stored: true }; }
    throw new Error("unexpected operation");
  } };
}
const recoveredJob: LifecycleJob = { deliveryId: "webhook", repository: context.repository, repositoryId: context.repositoryId, pullRequest: 43, headSha: context.headSha, attemptId: context.deliveryId!, eventTime: 0, body: "{}", event: "pull_request", signature: "offline", recoverySourceAttemptId: "old-attempt" };

test("after VM loss, only the server-authorized predecessor is verified and re-signed under the new root", async () => {
  const fixture = storeFixture();
  fixture.store.set(`old-attempt:${path}`, envelopeForArtifact(artifactBinding(context, "old-attempt"), "old-root", path, "preserved manifest", secret));
  const reader = durableEvidenceReader(context, "new-root", { ...fixture, secret, inspect: async () => recoveredJob });
  expect(await reader.readTextFile({ path })).toBe("preserved manifest");
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]!.rootScope).toBe("new-root");
  expect(fixture.writes[0]!.binding.attemptId).toBe("new-attempt");
  expect(authenticateArtifact(fixture.writes[0]!, artifactBinding(context), path, secret)).toBe("preserved manifest");
  fixture.store.delete(`old-attempt:${path}`);
  expect(await reader.readTextFile({ path })).toBe("preserved manifest");
  const unrelated = durableEvidenceReader({ ...context, deliveryId: "unrelated" }, "third-root", { ...fixture, secret, inspect: async () => ({ ...recoveredJob, recoverySourceAttemptId: undefined }) as LifecycleJob });
  expect(await unrelated.readTextFile({ path })).toBeNull();
});

test("signed identity, payload, path and root are checked before any recovery write", async () => {
  for (const change of [
    (row: ArtifactEnvelope) => ({ ...row, signedContent: row.signedContent + "forged" }),
    (row: ArtifactEnvelope) => ({ ...row, rootScope: "attacker-root" }),
    (row: ArtifactEnvelope) => ({ ...row, binding: { ...row.binding, headSha: "f".repeat(40) } }),
    (_row: ArtifactEnvelope) => envelopeForArtifact(artifactBinding({ ...context, reviewPolicyDigest: "e".repeat(64) }, "old-attempt"), "old-root", path, "old policy", secret),
  ]) {
    const fixture = storeFixture();
    fixture.store.set(`old-attempt:${path}`, change(envelopeForArtifact(artifactBinding(context, "old-attempt"), "old-root", path, "original", secret)));
    const reader = durableEvidenceReader(context, "new-root", { ...fixture, secret, inspect: async () => recoveredJob });
    await expect(reader.readTextFile({ path })).rejects.toThrow();
    expect(fixture.writes).toHaveLength(0);
  }
});

test("transient durable lookup errors propagate and never masquerade as missing evidence", async () => {
  let inspections = 0;
  const reader = durableEvidenceReader(context, "root", { secret, request: async () => { throw new Error("503 unavailable"); }, inspect: async () => { inspections += 1; return recoveredJob; } });
  await expect(reader.readTextFile({ path })).rejects.toThrow("503");
  expect(inspections).toBe(0);
});

function preparation() {
  const identity = { executionRevision: "review-evidence-v3" as const, repositoryId: context.repositoryId, repositoryDatabaseId: 1, repository: context.repository, pullRequest: 43, baseSha: context.baseSha, headSha: context.headSha, patchFingerprint: context.patchFingerprint!, planKind: "full" as const };
  const github = prepareExactHeadGitHubEvidence({ artifactsByRun: new Map(), checkRuns: [], workflowRuns: [], headSha: identity.headSha, repositoryDatabaseId: 1, observedAt: "2026-09-13T09:00:00Z" });
  return assembleReviewEvidenceLedger({ identity, manifest: { schemaVersion: 1, ...identity, entries: [] }, capabilities: { schemaVersion: 1, ...identity, network: "github-only", commands: [], repositoryMarkers: [], digest: "7".repeat(64) }, github: github.evidence, commonWork: commonWorkFixture(identity), probes: [] });
}
test("preparation-only recovery is eligible once; revision and root changes do not manufacture progress", async () => {
  const fixture = storeFixture();
  const put = (path: string, content: unknown, root = "old-root") => fixture.store.set(`old-attempt:${path}`, envelopeForArtifact(artifactBinding(context, "old-attempt"), root, path, JSON.stringify(content), secret));
  const absent = await artifactEligibility("old-attempt", context, { ...fixture, secret });
  expect(absent.eligible).toBe(false);
  const ledger = preparation();
  put(reviewEvidenceLedgerPath(context.patchFingerprint!), ledger);
  const ready = await artifactEligibility("old-attempt", context, { ...fixture, secret });
  expect(ready).toMatchObject({ eligible: true, artifactCount: 1, completedAxes: [] });
  const checkpointPath = `/tmp/known-good-review/checkpoints/review-context-v3/${context.patchFingerprint}/engineering-quality.json`;
  const checkpoint = { ...checkpointContent("engineering-quality"), schemaVersion: 3, axis: "engineering-quality", baseSha: context.baseSha, headSha: context.headSha, patchFingerprint: context.patchFingerprint, evidenceDigest: ledger.digest, revision: 1 };
  put(checkpointPath, checkpoint);
  const progressed = await artifactEligibility("old-attempt", context, { ...fixture, secret });
  expect(progressed.completedAxes).toEqual(["engineering-quality"]);
  expect(progressed.progressDigest).not.toBe(ready.progressDigest);
  put(checkpointPath, { ...checkpoint, revision: 2 }, "another-root");
  expect((await artifactEligibility("old-attempt", context, { ...fixture, secret })).progressDigest).toBe(progressed.progressDigest);
});

const modules = { "../convex/_generated/server.js": () => import("../convex/_generated/server.js"), "../convex/artifactData.ts": () => import("../convex/artifactData") };
test("Convex persists outside the VM, deduplicates retries and fences superseded or conflicting writes", async () => {
  const t = convexTest(schema, modules);
  const jobId = await t.run(async ctx => ctx.db.insert("reviewDeliveries", { deliveryId: "webhook", repository: context.repository, repositoryId: context.repositoryId, pullRequest: 43, headSha: context.headSha, eventTime: 0, body: "{}", event: "pull_request", signature: "offline", attemptId: context.deliveryId!, status: "running", leaseUntil: 1, nextAttemptAt: 0, attempts: 1 }));
  await t.run(ctx => ctx.db.insert("reviewOwners", { repositoryId: context.repositoryId, pullRequest: 43, deliveryId: "webhook", eventTime: 0 }));
  const envelope = envelopeForArtifact(artifactBinding(context), "new-root", path, "persisted", secret);
  const { signedContent, ...metadata } = envelope;
  const storageId = await t.run(ctx => ctx.storage.store(new Blob([signedContent])));
  const args = { ...metadata, storageId, digest: "digest-1", revision: 1 };
  expect(await t.mutation(internal.artifactData.put, args)).toBe(true);
  expect(await t.mutation(internal.artifactData.put, args)).toBe(false);
  const row = await t.query(internal.artifactData.get, { attemptId: context.deliveryId!, path });
  expect(await t.run(async ctx => (await ctx.storage.get(row!.storageId))!.text())).toBe(signedContent);
  await expect(t.mutation(internal.artifactData.put, { ...args, digest: "conflict" })).rejects.toThrow("stale or conflicting");
  await expect(t.mutation(internal.artifactData.put, { ...args, signedBinding: "forged" })).rejects.toThrow("immutable");
  await t.run(ctx => ctx.db.patch(jobId, { status: "superseded" }));
  await expect(t.mutation(internal.artifactData.put, args)).rejects.toThrow("no longer owns");
});

test("immutable predecessor links recover A artifacts through B after B's native session failed", async () => {
  const fixture = storeFixture();
  fixture.store.set(`old-attempt:${path}`, envelopeForArtifact(artifactBinding(context, "old-attempt"), "old-root", path, "A-only", secret));
  const middle = { ...envelopeForArtifact(artifactBinding(context, "middle-attempt"), "middle-root", "/tmp/known-good-review/admission.json", "receipt", secret), recoverySourceAttemptId: "old-attempt" };
  fixture.store.set(`middle-attempt:${middle.path}`, middle);
  const reader = durableEvidenceReader(context, "new-root", { ...fixture, secret, inspect: async () => ({ ...recoveredJob, recoverySourceAttemptId: "middle-attempt" }) });
  expect(await reader.readTextFile({ path })).toBe("A-only");
  expect(fixture.writes[0]?.binding.attemptId).toBe("new-attempt");
  fixture.store.delete(`old-attempt:${path}`);
  fixture.store.set(`old-attempt:${middle.path}`, { ...envelopeForArtifact(artifactBinding(context, "old-attempt"), "old-root", middle.path, "receipt", secret), recoverySourceAttemptId: "middle-attempt" } as ArtifactEnvelope);
  await expect(reader.readTextFile({ path: path + ".missing" })).rejects.toThrow("cycle");
});

test("durable state remains authoritative after a successful remote commit and failed local write", async () => {
  const old = { url: process.env.CONVEX_MEMORY_URL, token: process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN, key: process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY };
  process.env.CONVEX_MEMORY_URL = "https://fixture.invalid";
  process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = "offline-token";
  process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY = secret;
  const fixture = storeFixture();
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Response.json(await fixture.request(String(input).split("/").at(-1)!, JSON.parse(String(init?.body)))), { preconnect: () => {} }));
  try {
    const files = new Map<string, string>();
    let failWrite = false;
    const raw = { async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; }, async writeTextFile({ path, content }: { path: string; content: string }) { if (failWrite) { failWrite = false; throw new Error("VM write failed"); } files.set(path, content); } };
    await authenticatedEvidenceSandbox(raw, "new-root", secret).writeTextFile({ path, content: "stale local" });
    const auth = withTrustedReviewContext({ authenticator: "github", principalId: "review", principalType: "app", attributes: { repository: context.repository, installation_id: "1", pull_request_number: "43", delivery_id: context.deliveryId! } }, {
      baseSha: context.baseSha, headSha: context.headSha, patchFingerprint: context.patchFingerprint!, repositoryId: context.repositoryId, repositoryDatabaseId: 1, repositoryCreatedAt: 0, configSource: "", event: "pull_request", reviewFiles: [], plan: JSON.stringify({ kind: "full" }),
    });
    const ctx = { session: { id: "new-root", auth: { current: auth } }, getSandbox: async () => raw } as unknown as Pick<SessionContext, "session" | "getSandbox">;
    const sandbox = await getReviewEvidenceSandbox(ctx);
    failWrite = true;
    await expect(sandbox.writeTextFile({ path, content: "committed durable" })).rejects.toThrow("VM write failed");
    const restarted = await getReviewEvidenceSandbox(ctx);
    expect(await restarted.readTextFile({ path })).toBe("committed durable");
    expect(await authenticatedEvidenceSandbox(raw, "new-root", secret).readTextFile({ path })).toBe("committed durable");
  } finally {
    fetchSpy.mockRestore();
    for (const [name, value] of Object.entries({ CONVEX_MEMORY_URL: old.url, KNOWN_GOOD_REVIEW_MEMORY_TOKEN: old.token, KNOWN_GOOD_REVIEW_EVIDENCE_KEY: old.key })) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
