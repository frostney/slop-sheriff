import type { SessionAuthContext, SessionContext } from "eve/context";
import { authenticatedEvidenceSandbox, type TextSandbox } from "../../src/review/authenticated-evidence";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { durableEvidenceConfigured, durableEvidenceReader } from "../../src/review/durable-evidence";
import { localWorkspaceReceiptPath } from "../../src/review/physical-workspace";

/** Workflow tools cannot access a VM. This reader verifies and hydrates durable artifacts directly. */
export function getDurableReviewEvidenceReader(auth: SessionAuthContext | null | undefined, rootSessionId: string): TextSandbox | null {
  if (!durableEvidenceConfigured()) return null;
  const context = trustedGitHubContext(auth);
  if (!context.deliveryId || !context.patchFingerprint || !context.reviewPolicyDigest) throw new Error("Durable evidence requires the complete trusted review identity");
  return durableEvidenceReader(context, rootSessionId);
}

export async function getReviewEvidenceSandbox(ctx: Pick<SessionContext, "session" | "getSandbox">) {
  const rootScope = ctx.session.parent?.rootSessionId ?? ctx.session.id;
  const local = authenticatedEvidenceSandbox(await ctx.getSandbox(), rootScope, process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY);
  const durable = getDurableReviewEvidenceReader(ctx.session.auth.current, rootScope);
  if (!durable) return local;
  // A restored ledger is evidence, not proof that this VM has a checkout or dependencies.
  const durablePath = (path: string) => path.startsWith("/tmp/known-good-review/") && path !== localWorkspaceReceiptPath;
  return new Proxy(local, {
    get(target, property) {
      if (property === "writeBinaryFile") return async (options: { path: string; content: Uint8Array }) => {
        if (durablePath(options.path)) await durable.writeTextFile({ path: options.path, content: `known-good-review-binary-v1\n${Buffer.from(options.content).toString("base64")}` });
        await target.writeBinaryFile(options);
      };
      if (property === "readBinaryFile") return async (options: { path: string }) => {
        if (!durablePath(options.path)) return target.readBinaryFile(options);
        const recovered = await durable.readTextFile(options);
        if (recovered === null) return null;
        if (!recovered.startsWith("known-good-review-binary-v1\n")) throw new Error("Durable binary evidence encoding mismatch");
        const content = Buffer.from(recovered.slice("known-good-review-binary-v1\n".length), "base64");
        await target.writeBinaryFile({ ...options, content });
        return content;
      };
      if (property === "writeTextFile") return async (options: { path: string; content: string }) => {
        if (durablePath(options.path)) await durable.writeTextFile(options);
        await target.writeTextFile(options);
      };
      if (property === "readTextFile") return async (options: { path: string }) => {
        if (!durablePath(options.path)) return target.readTextFile(options);
        const recovered = await durable.readTextFile(options);
        if (recovered !== null) await target.writeTextFile({ ...options, content: recovered });
        return recovered;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
