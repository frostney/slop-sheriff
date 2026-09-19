import { describe, expect, test } from "bun:test";
import { ownsReviewLifecycle } from "../src/review/execution-session";
import { planReview } from "../src/review/lifecycle";

const head = "abc123";

describe("review lifecycle", () => {
  test("reserves publication and shared-sandbox teardown for the root", () => {
    expect(
      ownsReviewLifecycle({ channelKind: "github", hasParent: false }),
    ).toBe(true);
    expect(
      ownsReviewLifecycle({ channelKind: "subagent", hasParent: true }),
    ).toBe(false);
    expect(
      ownsReviewLifecycle({ channelKind: "subagent", hasParent: false }),
    ).toBe(false);
    expect(
      ownsReviewLifecycle({ channelKind: "github", hasParent: true }),
    ).toBe(false);
  });
  test("debounces a ready PR opened from the outset", () => {
    expect(
      planReview({
        action: "opened",
        baseline: { kind: "none", initial: "never" },
        draft: false,
        head,
      }),
    ).toEqual({
      kind: "full",
      delaySeconds: 600,
      reason: "initial",
      supersedesActiveReview: false,
    });
  });

  test("reviews the first draft-to-ready transition immediately", () => {
    expect(
      planReview({
        action: "ready_for_review",
        baseline: { kind: "none", initial: "never" },
        draft: false,
        head,
      }),
    ).toMatchObject({ kind: "full", delaySeconds: 0, reason: "initial" });
  });

  test("resets an initial debounce and supersedes a running initial review", () => {
    expect(
      planReview({
        action: "synchronize",
        baseline: { kind: "none", initial: "debouncing" },
        draft: false,
        head,
      }),
    ).toMatchObject({ kind: "full", delaySeconds: 600 });
    expect(
      planReview({
        action: "synchronize",
        baseline: { kind: "none", initial: "running" },
        draft: false,
        head,
      }),
    ).toMatchObject({
      kind: "full",
      delaySeconds: 0,
      supersedesActiveReview: true,
    });
  });

  test("runs deltas only after a completed baseline", () => {
    expect(
      planReview({
        action: "synchronize",
        baseline: {
          kind: "available",
          head: "old",
          patchFingerprint: "old-patch",
        },
        draft: false,
        head,
        patchFingerprint: "new-patch",
      }),
    ).toEqual({ kind: "delta", revalidatePriorFindings: true });
  });

  test("validates persistent work for merge and rebase semantic no-ops", () => {
    expect(
      planReview({
        action: "synchronize",
        baseline: {
          kind: "available",
          head: "old-commit",
          patchFingerprint: "same-effective-patch",
        },
        draft: false,
        head: "rebased-commit",
        patchFingerprint: "same-effective-patch",
      }),
    ).toEqual({ kind: "delta", revalidatePriorFindings: true });
  });

  test("never starts a replacement full review for a lost baseline", () => {
    expect(
      planReview({
        action: "synchronize",
        baseline: { kind: "lost" },
        draft: false,
        head,
        patchFingerprint: "patch",
      }),
    ).toEqual({ kind: "fail-closed", reason: "lost-baseline" });
  });

  test("allows an authorized manual full and supersedes queued work", () => {
    expect(
      planReview({
        action: "synchronize",
        baseline: { kind: "lost" },
        draft: false,
        head,
        manualFull: true,
        manualFullAuthorized: true,
      }),
    ).toEqual({
      kind: "full",
      delaySeconds: 0,
      reason: "manual",
      supersedesActiveReview: true,
    });
  });

  test("drafting cancels and closing cleans up", () => {
    expect(
      planReview({
        action: "converted_to_draft",
        baseline: { kind: "none", initial: "running" },
        draft: true,
        head,
      }),
    ).toEqual({ kind: "cancel", reason: "draft" });
    expect(
      planReview({
        action: "closed",
        baseline: { kind: "lost" },
        draft: false,
        head,
      }),
    ).toEqual({ kind: "cleanup", reason: "closed-or-merged" });
  });
});
