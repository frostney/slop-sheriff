import type { TrustedGitHubContext } from "../github/trusted-context";
import type { ReviewEvidenceLedger } from "./evidence-ledger";

/** Signed by the local evidence wrapper, but never copied to or from durable storage. */
export const localWorkspaceReceiptPath = "/tmp/known-good-review/local-workspace.json";

export function physicalWorkspaceReceipt(sandboxId: string | undefined, trusted: TrustedGitHubContext, ledger: ReviewEvidenceLedger): string {
  return JSON.stringify({
    revision: "review-physical-workspace-v1", sandboxId: sandboxId ?? null,
    attemptId: trusted.deliveryId ?? null, reviewPolicyDigest: trusted.reviewPolicyDigest ?? null,
    identity: ledger.identity, ledgerDigest: ledger.digest,
  });
}
