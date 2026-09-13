import { expect, test } from "bun:test";
import type { WorkflowToolContext } from "eve/tools";
import { reusableReviewLane, reviewOrchestrationPlan, verifyReviewLaneReceipt } from "../agent/lib/review-workflow";
import { authenticatedEvidenceSandbox } from "../src/review/authenticated-evidence";
import { withTrustedReviewContext } from "../src/github/trusted-context";
import { currentLaneCheckpointIdentity } from "../agent/lib/review-evidence";
import { assembleReviewEvidenceLedger, writeReviewEvidenceLedger } from "../src/review/evidence-ledger";
import { writeReviewEvidenceManifest, writeIncludedReviewEvidence, readNextReviewEvidencePacket } from "../src/review/evidence-bundle";
import { runCapabilityPreflight, capabilityCommandNames } from "../src/review/capability-preflight";
import { prepareExactHeadGitHubEvidence } from "../src/review/github-evidence";
import { writeLaneCheckpoint } from "../src/review/lane-checkpoint";
import { commonWorkFixture } from "./common-work-fixture";
import { checkpointContent } from "./fixtures/eve-runtime-smoke/agent/lib/orchestration";

test("workflow reuse validates persisted checkpoint and packet progress without a sandbox handle", async () => {
  const saved = process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY;
  const secret = "12".repeat(32);
  process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY = secret;
  try {
    const files = new Map<string, string>();
    const sandbox = authenticatedEvidenceSandbox({
      async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; },
      async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content); },
      async removePath() { throw new Error("Checkpoint reuse cannot remove evidence"); },
      async run() { return { exitCode: 0, stderr: "", stdout: capabilityCommandNames.map(name => `command\t${name}\t1`).join("\n") }; },
    }, "recovered-root", secret);
    const identity = {
      executionRevision: "review-evidence-v3" as const, repositoryId: "R_reuse", repositoryDatabaseId: 1,
      repository: "owner/repo", pullRequest: 43, baseSha: "a".repeat(40), headSha: "b".repeat(40),
      patchFingerprint: "c".repeat(64), planKind: "full" as const,
    };
    const auth = withTrustedReviewContext({ authenticator: "github", principalId: "review", principalType: "app",
      attributes: { repository: identity.repository, installation_id: "1", pull_request_number: "43" } }, {
      ...identity, repositoryCreatedAt: 0, configSource: "", event: "pull_request", reviewFiles: [],
      plan: JSON.stringify({ kind: "full", activeAxes: ["engineering-quality"], selectedFindingIds: [] }),
    });
    const ctx = { callId: "workflow-call", session: { id: "recovered-root", auth: { current: auth, initiator: auth }, turn: { id: "turn", sequence: 0 } } } as WorkflowToolContext;
    const entry = await writeIncludedReviewEvidence(sandbox, { patchFingerprint: identity.patchFingerprint,
      path: "src/index.ts", status: "modified", patch: "+1", patchTokens: 1 });
    const manifest = { schemaVersion: 1 as const, ...identity, entries: [entry] };
    const capabilities = await runCapabilityPreflight(sandbox, identity);
    const github = prepareExactHeadGitHubEvidence({ artifactsByRun: new Map(), checkRuns: [], workflowRuns: [],
      headSha: identity.headSha, repositoryDatabaseId: 1, observedAt: "2026-09-13T09:00:00Z" });
    const ledger = assembleReviewEvidenceLedger({ identity, manifest, capabilities: capabilities.preflight,
      github: github.evidence, commonWork: commonWorkFixture(identity), probes: [] });
    await writeReviewEvidenceManifest(sandbox, manifest);
    await writeReviewEvidenceLedger(sandbox, ledger);
    expect(await reusableReviewLane(ctx, "engineering-quality", "reuse", sandbox)).toBeNull();
    const checkpointIdentity = await currentLaneCheckpointIdentity(auth, sandbox);
    await writeLaneCheckpoint(sandbox, checkpointIdentity, "engineering-quality", {
      ...checkpointContent("engineering-quality"), reviewedEntries: [0],
    }, 1);
    await expect(reusableReviewLane(ctx, "engineering-quality", "reuse", sandbox)).rejects.toThrow("application-recorded evidence coverage");
    await readNextReviewEvidencePacket(sandbox, manifest, "engineering-quality", "previous-worker", 0);
    const receipt = await reusableReviewLane(ctx, "engineering-quality", "reuse", sandbox);
    const verified = verifyReviewLaneReceipt({ raw: receipt, axis: "engineering-quality", attempt: 0,
      invocationId: "workflow-call:reuse", plan: reviewOrchestrationPlan(ctx, "Review current behavior"), secret });
    expect(verified.attestation).toMatchObject({ rootSessionId: "recovered-root", status: "complete", operation: "read" });
    expect(await reusableReviewLane(ctx, "engineering-quality", "reuse", null)).toBeNull();
  } finally {
    if (saved === undefined) delete process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY;
    else process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY = saved;
  }
});
