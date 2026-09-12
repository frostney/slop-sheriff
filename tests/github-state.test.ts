import { describe, expect, test } from "bun:test";
import type {
  ChannelFrom,
  ChannelSendOptions,
  Session,
} from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import {
  decodeReviewState,
  encodeReviewState,
  isReviewStateComment,
  pendingReviewState,
} from "../src/github/review-state";
import {
  addressesKnownGoodReview,
  acknowledgeManualFullReview,
  canRequestManualFull,
  requestsManualFullReview,
  reviewControlResponse,
} from "../src/github/manual-full";
import {
  startsFreshReviewSession,
  withFreshReviewSessions,
} from "../src/github/session-routing";
import { reviewContextAttributes } from "../src/github/trusted-context";
import {
  advanceReviewRecovery,
  beginReviewRecovery,
  buildReviewFailureEnvelope,
} from "../src/review/recovery";

test("new and legacy commands require the exact bot name", () => {
  for (const name of ["slop-sheriff", "known-good-review"]) {
    expect(requestsManualFullReview(`@${name} run full review`)).toBeTrue();
    expect(requestsManualFullReview(`/${name} full review`)).toBeTrue();
    expect(addressesKnownGoodReview(`@${name} continue`)).toBeTrue();
    expect(reviewControlResponse(`@${name} continue`)).toBe("approve");
    expect(addressesKnownGoodReview(`@${name}-other continue`)).toBeFalse();
    expect(requestsManualFullReview(`@${name}-other full review`)).toBeFalse();
  }
});

test("branding preserves legacy state decoding and publication voice", () => {
  const state = pendingReviewState({
    pullRequest: 7,
    status: "running",
    publication: { blocking: false, profile: "balanced", personality: false },
  });
  const plain = encodeReviewState(state);
  expect(plain).toContain("Slop Sheriff: reviewing");
  expect(plain).not.toContain("on patrol");
  expect(decodeReviewState(plain)).toEqual(state);
  expect(decodeReviewState(plain.replace("Slop Sheriff:", "known-good-review:"))).toEqual(state);
  expect(isReviewStateComment(`### A finding\n\n${plain}`)).toBeFalse();
  const cowboy = encodeReviewState({ ...state, publication: { blocking: false, profile: "balanced", personality: true } });
  expect(cowboy).not.toContain("on patrol");
});

function reviewAuth(
  kind: "delta" | "full",
  event = "synchronize",
): SessionAuthContext {
  return {
    attributes: {
      [reviewContextAttributes.event]: event,
      [reviewContextAttributes.plan]: JSON.stringify({ kind }),
    },
    authenticator: "github",
    principalId: "frostney",
    principalType: "user",
  };
}

describe("GitHub-owned state and telemetry", () => {
  test("round-trips state behind a visible GitHub result", () => {
    const state = {
      schemaVersion: 2 as const,
      app: "known-good-review" as const,
      pullRequest: 42,
      initialFullStatus: "completed" as const,
      baseline: {
        head: "abc123",
        patchFingerprint: "a".repeat(64),
        findingsArtifactUrl: "https://github.com/acme/repo/checks/1",
        files: { "src/index.ts": "b".repeat(64) },
        report: {
          schemaVersion: 2 as const,
          kind: "code-review" as const,
          generatedAt: "2026-08-16T12:00:00.000Z",
          verdict: "APPROVE" as const,
          scope: {
            claim: "Test the state marker",
            base: "base123",
            head: "abc123",
            dirtyState: "clean",
          },
          coverage: {
            activeAxes: [
              "deduplication" as const,
              "claim-and-specification" as const,
              "engineering-quality" as const,
            ],
            skippedAxes: [
              { name: "discoverability", reason: "No public web surface" },
            ],
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
    const encoded = encodeReviewState(state);
    expect(encoded).toContain("## ✅ Slop Sheriff: clear");
    expect(encoded).not.toContain("Patrol complete");
    expect(decodeReviewState(encoded)).toEqual(state);
    expect(decodeReviewState("ordinary comment")).toBeNull();

    const recovery = advanceReviewRecovery(
      beginReviewRecovery({
        activeAxes: ["engineering-quality"],
        identity: {
          baseSha: "1".repeat(40),
          headSha: "2".repeat(40),
          patchFingerprint: "3".repeat(64),
          planKind: "delta",
        },
        selectedFindingIds: ["CR-7"],
      }),
      {
        completedAxes: ["engineering-quality"],
        stage: "axes-complete",
      },
    );
    const failed = {
      ...state,
      failure: buildReviewFailureEnvelope({
        errorClass: "WORKFLOW_INCOMPLETE",
        recovery,
        run: { sessionId: "session-safe", turnId: "turn-safe" },
      }),
    };
    const encodedFailure = encodeReviewState(failed);
    expect(encodedFailure).toContain("review incomplete");
    expect(decodeReviewState(encodedFailure)).toEqual(failed);
  });

  test("shows accepted review progress instead of an empty state comment", () => {
    const body = encodeReviewState(
      pendingReviewState({ pullRequest: 42, status: "running" }),
    );
    expect(body).toContain("## ⏳ Slop Sheriff: reviewing");
    expect(body).toContain("The current revision is being reviewed.");
    expect(decodeReviewState(body)?.initialFullStatus).toBe("running");
  });

  test("recognizes manual full commands and repository write authority", () => {
    expect(
      requestsManualFullReview("@known-good-review run full review please"),
    ).toBeTrue();
    expect(requestsManualFullReview("@known-good-review review this")).toBeFalse();
    expect(canRequestManualFull("write")).toBeTrue();
    expect(canRequestManualFull("maintain")).toBeTrue();
    expect(canRequestManualFull("read")).toBeFalse();
  });

  test("passes ordinary bot mentions to Eve's native response handling", () => {
    expect(addressesKnownGoodReview("@known-good-review Approve")).toBeTrue();
    expect(addressesKnownGoodReview("please @known-good-review Stop")).toBeTrue();
    expect(addressesKnownGoodReview("@known-good-reviewer Approve")).toBeFalse();
    expect(addressesKnownGoodReview("Approve")).toBeFalse();
    expect(reviewControlResponse("@known-good-review Approve")).toBe(
      "approve",
    );
    expect(reviewControlResponse("@known-good-review continue")).toBe(
      "approve",
    );
    expect(reviewControlResponse("@known-good-review Stop")).toBe("stop");
    expect(reviewControlResponse("@known-good-review review this")).toBeNull();
  });

  test("starts each review in a fresh PR session but preserves approvals", async () => {
    expect(startsFreshReviewSession(reviewAuth("full"))).toBeTrue();
    expect(startsFreshReviewSession(reviewAuth("delta"))).toBeTrue();
    expect(
      startsFreshReviewSession(
        reviewAuth("full", "review-control-response"),
      ),
    ).toBeFalse();

    const events: string[] = [];
    const from = (() => ({
      reset: async () => {
        events.push("reset");
        return {
          previousSessionId: "old-session",
          status: "reset" as const,
        };
      },
      send: async (_message: unknown, options: ChannelSendOptions) => {
        events.push(`send:${options.mode ?? "conversation"}`);
        return {} as Session;
      },
    })) as unknown as ChannelFrom;
    const routed = withFreshReviewSessions(from);
    await routed("repo:1:pull:53").send("review", {
      auth: reviewAuth("full"),
    });
    expect(events).toEqual(["reset", "send:task"]);

    events.length = 0;
    await routed("repo:1:pull:53").send("Approve", {
      auth: reviewAuth("full", "review-control-response"),
    });
    expect(events).toEqual(["send:conversation"]);
  });

  test("acknowledges the exact manual trigger without blocking the review", async () => {
    const reactions: string[] = [];
    expect(
      await acknowledgeManualFullReview({
        react: async (reaction) => {
          reactions.push(reaction);
        },
      }),
    ).toBeTrue();
    expect(reactions).toEqual(["eyes"]);
    expect(
      await acknowledgeManualFullReview({
        react: async () => {
          throw new Error("reaction unavailable");
        },
      }),
    ).toBeFalse();
  });

});
