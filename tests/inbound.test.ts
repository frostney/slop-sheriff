import { reviewPolicyDigest } from "../src/config/review-policy-identity";
import { describe, expect, test } from "bun:test";
import { planDispatch, reviewStateFromComments } from "../src/github/inbound";
import { effectivePatchFingerprint } from "../src/review/effective-patch";
import type { ReviewState } from "../src/github/review-state";
import { encodeReviewState } from "../src/github/review-state";

const botUser = { id: 123, login: "known-good-review[bot]", type: "Bot" };

const oldFiles = [
  {
    blobSha: "blob-a",
    path: "src/a.ts",
    status: "modified" as const,
    patch: "@@ -1 +1 @@\n-old\n+new",
  },
  {
    blobSha: "blob-b",
    path: "src/b.ts",
    status: "added" as const,
    patch: "@@ -0 +1 @@\n+same",
  },
];

function completedState(): ReviewState {
  return {
    schemaVersion: 2,
    app: "known-good-review",
    pullRequest: 7,
    initialFullStatus: "completed",
    baseline: {
      head: "old-head",
      patchFingerprint: effectivePatchFingerprint(oldFiles),
      findingsArtifactUrl: "https://github.com/acme/repo/runs/1",
      files: {
        "src/a.ts": effectivePatchFingerprint([oldFiles[0]!]),
        "src/b.ts": effectivePatchFingerprint([oldFiles[1]!]),
      },
      report: {
        schemaVersion: 2,
        kind: "code-review",
        generatedAt: "2026-08-16T12:00:00.000Z",
        verdict: "APPROVE",
        scope: {
          claim: "test",
          base: "base",
          head: "old-head",
          dirtyState: "clean",
        },
        coverage: {
          activeAxes: [
            "deduplication",
            "claim-and-specification",
            "engineering-quality",
          ],
          skippedAxes: [],
          staticOnly: [],
          unreached: [],
        },
        churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
        probes: [],
        findings: [],
        verifiedClaims: [],
        limitations: [],
      },
    },
    updatedAt: "2026-08-16T12:00:00.000Z",
  };
}

describe("GitHub inbound planning", () => {
  test("does not trust copied state and finding markers from other authors", () => {
    const state = completedState();
    for (const user of [null, { ...botUser, type: "User" }, {
      ...botUser, login: "another-app[bot]",
    }]) {
      expect(reviewStateFromComments([
        { user, body: encodeReviewState(state) },
        { user, body: "<!-- known-good-review:finding:CR-1 -->" },
      ])).toEqual({ kind: "absent" });
    }
    const forged = { ...state, updatedAt: "2099-01-01T00:00:00.000Z" };
    expect(reviewStateFromComments([
      { user: botUser, body: encodeReviewState(state) },
      { user: { ...botUser, type: "User" }, body: encodeReviewState(forged) },
    ])).toEqual({ kind: "valid", state });
  });

  test("treats malformed or missing authoritative state as lost when evidence remains", () => {
    expect(
      reviewStateFromComments([
        { user: botUser, body: "<!-- known-good-review:state\nnot-valid\n-->" },
      ]),
    ).toEqual({ kind: "lost" });
    expect(
      reviewStateFromComments([
        { user: botUser, body: "<!-- known-good-review:finding:CR-1 -->" },
      ]),
    ).toEqual({ kind: "lost" });
    expect(reviewStateFromComments([{ user: botUser, body: "ordinary" }])).toEqual({
      kind: "absent",
    });
  });

  test("recovers the latest valid state marker", () => {
    const state = completedState();
    expect(
      reviewStateFromComments([{ user: botUser, body: encodeReviewState(state) }]),
    ).toEqual({ kind: "valid", state });
  });

  test("does not rerun a full review for a semantic rebase", () => {
    const rebased = oldFiles.map((file) => ({
      ...file,
      patch: file.patch.replace("@@ -1 +1 @@", "@@ -200 +200 @@"),
    }));
    expect(
      planDispatch({
        action: "synchronize",
        draft: false,
        head: "rebased-head",
        patchFiles: rebased,
        state: { kind: "valid", state: completedState() },
      }).plan,
    ).toEqual({ kind: "reuse", reason: "semantic-no-op" });
  });

  test("selects only files whose effective patch changed", () => {
    const current = [
      {
        ...oldFiles[0]!,
        blobSha: "blob-a-new",
        patch: "@@ -40 +40 @@\n-old\n+newer",
      },
      { ...oldFiles[1]!, patch: "@@ -0 +90 @@\n+same" },
    ];
    const dispatch = planDispatch({
      action: "synchronize",
      draft: false,
      head: "new-head",
      patchFiles: current,
      state: { kind: "valid", state: completedState() },
    });
    expect(dispatch.plan).toEqual({
      kind: "delta",
      revalidatePriorFindings: true,
    });
    expect(dispatch.changedFiles).toEqual(["src/a.ts"]);
  });

  test("resets debounce but immediately supersedes a running initial review", () => {
    const pending = (status: "debouncing" | "running"): ReviewState => ({
      schemaVersion: 2,
      app: "known-good-review",
      pullRequest: 7,
      initialFullStatus: status,
      baseline: null,
      updatedAt: "2026-08-16T12:00:00.000Z",
    });
    expect(
      planDispatch({
        action: "synchronize",
        draft: false,
        head: "head",
        patchFiles: oldFiles,
        state: { kind: "valid", state: pending("debouncing") },
      }).plan,
    ).toMatchObject({ kind: "full", delaySeconds: 600 });
    expect(
      planDispatch({
        action: "synchronize",
        draft: false,
        head: "head",
        patchFiles: oldFiles,
        state: { kind: "valid", state: pending("running") },
      }).plan,
    ).toMatchObject({
      kind: "full",
      delaySeconds: 0,
      supersedesActiveReview: true,
    });
  });
});


test("changed trusted configuration or base invalidates semantic reuse, including legacy baselines", () => {
  const digest = reviewPolicyDigest("", "base-one");
  const old = completedState();
  if (!old.baseline) throw new Error("Expected baseline");
  const state = { ...old, baseline: { ...old.baseline, reviewPolicyDigest: digest } };
  const dispatch = (policy: string, saved = state) => planDispatch({ action: "synchronize", draft: false, head: "same-patch-head", patchFiles: oldFiles, state: { kind: "valid", state: saved }, reviewPolicyDigest: policy });
  expect(dispatch(digest).plan.kind).toBe("reuse");
  for (const changed of [
    reviewPolicyDigest("voice: off", "base-one"),
    reviewPolicyDigest("model: openai/gpt-5.6-luna", "base-one"),
    reviewPolicyDigest("", "base-two"),
    reviewPolicyDigest('lanes: [{id: project-api, name: API, criteria: Preserve wire format, always: true}]', "base-one"),
  ]) expect(dispatch(changed).plan).toMatchObject({ kind: "full", delaySeconds: 0 });
  expect(planDispatch({ action: "synchronize", draft: false, head: "same-head", patchFiles: oldFiles, state: { kind: "valid", state: old }, reviewPolicyDigest: digest }).plan.kind).toBe("full");
  expect(planDispatch({ action: "closed", draft: false, head: "same-head", patchFiles: oldFiles, state: { kind: "valid", state: old }, reviewPolicyDigest: digest }).plan.kind).toBe("cleanup");
});
