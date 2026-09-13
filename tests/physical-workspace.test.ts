import { expect, spyOn, test } from "bun:test";
import type { SessionContext } from "eve/context";
import { getReviewEvidenceSandbox } from "../agent/lib/evidence-sandbox";
import { withTrustedReviewContext } from "../src/github/trusted-context";
import { localWorkspaceReceiptPath } from "../src/review/physical-workspace";

test("physical preparation receipt is locally authenticated and cannot survive VM loss through durable hydration", async () => {
  const original = { CONVEX_MEMORY_URL: process.env.CONVEX_MEMORY_URL, KNOWN_GOOD_REVIEW_MEMORY_TOKEN: process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN, KNOWN_GOOD_REVIEW_EVIDENCE_KEY: process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY };
  Object.assign(process.env, { CONVEX_MEMORY_URL: "https://fixture.invalid", KNOWN_GOOD_REVIEW_MEMORY_TOKEN: "offline-token", KNOWN_GOOD_REVIEW_EVIDENCE_KEY: "ab".repeat(32) });
  const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("A physical receipt must never access durable storage"));
  const auth = withTrustedReviewContext({ authenticator: "github", principalId: "review", principalType: "app", attributes: { repository: "acme/repo", installation_id: "1", pull_request_number: "43", delivery_id: "attempt" } }, {
    baseSha: "a".repeat(40), headSha: "b".repeat(40), patchFingerprint: "c".repeat(64), repositoryId: "R_repo", repositoryDatabaseId: 1, repositoryCreatedAt: 0, configSource: "", event: "pull_request", reviewFiles: [], plan: JSON.stringify({ kind: "full" }),
  });
  const wrap = async (files: Map<string, string>) => getReviewEvidenceSandbox({ session: { id: "root", auth: { current: auth } }, getSandbox: async () => ({
    async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; },
    async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content); },
  }) } as unknown as Pick<SessionContext, "session" | "getSandbox">);
  try {
    const files = new Map<string, string>();
    const sandbox = await wrap(files);
    await sandbox.writeTextFile({ path: localWorkspaceReceiptPath, content: "physical preparation completed" });
    expect(files.get(localWorkspaceReceiptPath)).toStartWith("known-good-review-signed-v1 ");
    expect(await (await wrap(files)).readTextFile({ path: localWorkspaceReceiptPath })).toBe("physical preparation completed");
    expect(await (await wrap(new Map())).readTextFile({ path: localWorkspaceReceiptPath })).toBeNull();
    files.set(localWorkspaceReceiptPath, "forged preparation completed");
    await expect(sandbox.readTextFile({ path: localWorkspaceReceiptPath })).rejects.toThrow("authentication failed");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
