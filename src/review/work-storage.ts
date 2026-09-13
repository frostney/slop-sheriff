import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { TrustedGitHubContext } from "../github/trusted-context";
import { evidenceSigningKey } from "./authenticated-evidence";
import { completedWorkBindingSchema, completedWorkEnvelopeSchema, completedWorkKeySchema, workDigestSchema, type CompletedWorkEnvelope, type CompletedWorkKey } from "./work-storage-contracts";

const domain = "slop-sheriff-completed-work-v1";
type WorkContext = Pick<TrustedGitHubContext, "repositoryId" | "pullRequest" | "deliveryId">;
export interface CompletedReviewWork { readonly data: string; readonly sourceAttemptId: string; readonly scopeKey: string; readonly inputDigest: string; }
export function completedWorkDigest(data: string): string { return createHash("sha256").update(data).digest("hex"); }
function signature(envelope: Pick<CompletedWorkEnvelope, "binding" | "data">, secret: string | undefined): string {
  return createHmac("sha256", evidenceSigningKey(secret)).update(JSON.stringify([domain, completedWorkBindingSchema.parse(envelope.binding), envelope.data])).digest("hex");
}
export function signCompletedReviewWork(context: WorkContext, input: CompletedWorkKey & { readonly data: string }, secret: string | undefined): CompletedWorkEnvelope {
  const binding = completedWorkBindingSchema.parse({ version: 1, repositoryId: context.repositoryId, pullRequest: context.pullRequest, sourceAttemptId: context.deliveryId, ...completedWorkKeySchema.parse({ scopeKey: input.scopeKey, inputDigest: input.inputDigest }), contentDigest: completedWorkDigest(input.data) });
  return completedWorkEnvelopeSchema.parse({ binding, data: input.data, signature: signature({ binding, data: input.data }, secret) });
}
export function authenticateCompletedReviewWork(raw: unknown, context: WorkContext, expected: { readonly scopeKey: string; readonly inputDigest?: string }, secret: string | undefined): CompletedReviewWork {
  const envelope = completedWorkEnvelopeSchema.parse(raw);
  const binding = envelope.binding;
  if (binding.repositoryId !== context.repositoryId || binding.pullRequest !== context.pullRequest || binding.scopeKey !== expected.scopeKey || expected.inputDigest !== undefined && binding.inputDigest !== expected.inputDigest || completedWorkDigest(envelope.data) !== binding.contentDigest || !timingSafeEqual(Buffer.from(envelope.signature, "hex"), Buffer.from(signature(envelope, secret), "hex"))) throw new Error("Completed review work authentication failed");
  return { data: envelope.data, sourceAttemptId: binding.sourceAttemptId, scopeKey: binding.scopeKey, inputDigest: binding.inputDigest };
}
export async function completedWorkRequest(operation: "put" | "get" | "latest", body: unknown): Promise<unknown> {
  const base = process.env.CONVEX_MEMORY_URL?.replace(/\/$/, "");
  const token = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  if (!base || !token) throw new Error("Completed review work storage is not configured");
  const response = await fetch(`${base}/review-work/${operation}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Completed review work ${operation} failed (${response.status})`);
  return response.json();
}

/** App-only adapter: scope/dependency keys must be derived by the trusted planner. */
export function completedReviewWorkStore(context: WorkContext, dependencies: { readonly secret?: string; readonly request?: typeof completedWorkRequest } = {}) {
  if (!context.deliveryId) throw new Error("Completed review work requires an admitted attempt");
  const request = dependencies.request ?? completedWorkRequest;
  const secret = dependencies.secret ?? process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY;
  return {
    async put(input: CompletedWorkKey & { readonly data: string }): Promise<"stored" | "duplicate"> {
      const envelope = signCompletedReviewWork(context, input, secret);
      const result = await request("put", { currentAttemptId: context.deliveryId, envelope });
      return z.object({ result: z.enum(["stored", "duplicate"]) }).parse(result).result;
    },
    async get(key: CompletedWorkKey): Promise<CompletedReviewWork | null> {
      const validated = completedWorkKeySchema.parse(key);
      const result = await request("get", { currentAttemptId: context.deliveryId, ...validated });
      return result === null ? null : authenticateCompletedReviewWork(result, context, validated, secret);
    },
    /** Historical context only. The caller must validate current dependencies before reuse. */
    async latest(input: { readonly scopeKey: string }): Promise<CompletedReviewWork | null> {
      const scopeKey = workDigestSchema.parse(input.scopeKey);
      const result = await request("latest", { currentAttemptId: context.deliveryId, scopeKey });
      return result === null ? null : authenticateCompletedReviewWork(result, context, { scopeKey }, secret);
    },
  };
}
