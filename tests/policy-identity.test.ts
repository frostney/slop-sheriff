import { expect, spyOn, test } from "bun:test";
import { reviewPolicyDigest } from "../src/config/review-policy-identity";
import * as policy from "../src/review/policy";
import { recoveryPolicy } from "../src/lifecycle/recovery-policy";
import { trustedGitHubContext, withTrustedReviewContext } from "../src/github/trusted-context";

test("runtime policy changes invalidate recovery evidence without a manual version bump", () => {
  const base = "a".repeat(40);
  const original = reviewPolicyDigest("", base);
  const changed = spyOn(policy, "reviewChildInstructions").mockReturnValue("A newly required behavioral verification.");
  try { expect(reviewPolicyDigest("", base)).not.toBe(original); }
  finally { changed.mockRestore(); }
  expect(reviewPolicyDigest("", base)).toBe(original);
  expect(reviewPolicyDigest("", "b".repeat(40))).not.toBe(original);
  expect(reviewPolicyDigest("personality: false", base)).not.toBe(original);
});

test("recovery checks current policy and saved identity before reusing paid evidence", () => {
  const auth = withTrustedReviewContext({ authenticator: "github", principalId: "review", principalType: "app",
    attributes: { repository: "owner/repo", installation_id: "1", pull_request_number: "43" } }, {
    repositoryId: "R_repo", repositoryDatabaseId: 1, repositoryCreatedAt: 0, baseSha: "a".repeat(40),
    headSha: "b".repeat(40), patchFingerprint: "c".repeat(64), configSource: "", event: "pull_request",
    reviewFiles: [], plan: JSON.stringify({ kind: "full", activeAxes: ["engineering-quality"], selectedFindingIds: [] }),
  });
  const expected = trustedGitHubContext(auth);
  const saved = JSON.stringify(auth);
  expect(recoveryPolicy(saved, expected)).toMatchObject({ reuse: true });
  const changed = spyOn(policy, "reviewChildInstructions").mockReturnValue("Changed verification requirement.");
  try { expect(recoveryPolicy(saved, expected)).toMatchObject({ reuse: false }); }
  finally { changed.mockRestore(); }
  expect(() => recoveryPolicy(saved, { ...expected, repositoryId: "R_other" })).toThrow("does not match");
  expect(() => recoveryPolicy(saved, { ...expected, headSha: "d".repeat(40) })).toThrow("does not match");
  expect(() => recoveryPolicy(undefined, expected)).toThrow("trusted configuration snapshot");
});
