import type { HttpRouter } from "convex/server";
import { z } from "zod";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { completedWorkEnvelopeSchema, completedWorkKeySchema, workDigestSchema } from "../src/review/work-storage-contracts";
import { evidenceWriteClaimSchema } from "../src/review/durable-evidence-contracts";

async function digest(data: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data))), byte => byte.toString(16).padStart(2, "0")).join("");
}
export function registerReviewWorkRoutes(http: HttpRouter, isAuthorized: (request: Request) => Promise<boolean>): void {
  http.route({ path: "/review-work/put", method: "POST", handler: httpAction(async (ctx, request) => {
    if (!await isAuthorized(request)) return new Response(null, { status: 401 });
    const parsed = z.strictObject({ currentAttemptId: z.string().min(1), envelope: completedWorkEnvelopeSchema, writeClaim: evidenceWriteClaimSchema.optional() }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response(null, { status: 400 });
    const { currentAttemptId, envelope, writeClaim } = parsed.data;
    if (await digest(envelope.data) !== envelope.binding.contentDigest) return Response.json({ error: "corrupt_payload" }, { status: 400 });
    const storageId = await ctx.storage.store(new Blob([envelope.data], { type: "text/plain" }));
    // Preserve the blob on an unknown mutation outcome: it may already be committed.
    const result = await ctx.runMutation(internal.reviewWorkData.put, { currentAttemptId, binding: envelope.binding, signature: envelope.signature, storageId, byteLength: new TextEncoder().encode(envelope.data).byteLength, ...(writeClaim ? { writeClaim } : {}) });
    if (result !== "stored") await ctx.storage.delete(storageId);
    return Response.json({ result }, { status: result === "forbidden" ? 403 : 200 });
  }) });
  for (const operation of ["get", "latest"] as const) http.route({ path: `/review-work/${operation}`, method: "POST", handler: httpAction(async (ctx, request) => {
    if (!await isAuthorized(request)) return new Response(null, { status: 401 });
    const parsed = (operation === "get" ? completedWorkKeySchema.extend({ currentAttemptId: z.string().min(1) }) : z.strictObject({ currentAttemptId: z.string().min(1), scopeKey: workDigestSchema })).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response(null, { status: 400 });
    const record = "inputDigest" in parsed.data ? await ctx.runQuery(internal.reviewWorkData.get, completedWorkKeySchema.extend({ currentAttemptId: z.string().min(1) }).parse(parsed.data)) : await ctx.runQuery(internal.reviewWorkData.latest, parsed.data);
    if (record.kind === "forbidden") return new Response(null, { status: 403 });
    if (record.kind === "missing") return Response.json(null);
    const blob = await ctx.storage.get(record.storageId);
    if (!blob) return Response.json({ error: "completed_work_blob_missing" }, { status: 503 });
    const data = await blob.text();
    if (await digest(data) !== record.binding.contentDigest || new TextEncoder().encode(data).byteLength !== record.byteLength) return Response.json({ error: "completed_work_blob_corrupt" }, { status: 503 });
    return Response.json({ binding: record.binding, signature: record.signature, data });
  }) });
}
