import type { HttpRouter } from "convex/server";
import { z } from "zod";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { artifactEnvelopeSchema, artifactPathSchema } from "../src/review/durable-evidence-contracts";

export function registerArtifactRoutes(http: HttpRouter, isAuthorized: (request: Request) => Promise<boolean>): void {
  http.route({ path: "/review-artifacts/put", method: "POST", handler: httpAction(async (ctx, request) => {
    if (!await isAuthorized(request)) return new Response(null, { status: 401 });
    const parsed = artifactEnvelopeSchema.extend({ revision: z.number().int().positive().optional() }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response(null, { status: 400 });
    const { signedContent, revision, ...metadata } = parsed.data;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signedContent))), byte => byte.toString(16).padStart(2, "0")).join("");
    const storageId = await ctx.storage.store(new Blob([signedContent], { type: "text/plain" }));
    try {
      const stored = await ctx.runMutation(internal.artifactData.put, { ...metadata, storageId, digest, ...(revision !== undefined ? { revision } : {}) });
      if (!stored) await ctx.storage.delete(storageId);
      return Response.json({ stored: true });
    } catch (error) { await ctx.storage.delete(storageId); throw error; }
  }) });
  http.route({ path: "/review-artifacts/get", method: "POST", handler: httpAction(async (ctx, request) => {
    if (!await isAuthorized(request)) return new Response(null, { status: 401 });
    const parsed = z.strictObject({ attemptId: z.string().min(1), path: artifactPathSchema }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response(null, { status: 400 });
    const row = await ctx.runQuery(internal.artifactData.get, parsed.data);
    if (!row) return Response.json(null);
    const blob = await ctx.storage.get(row.storageId);
    if (!blob) throw new Error("Durable evidence blob is missing");
    return Response.json({ binding: row.binding, rootScope: row.rootScope, signedBinding: row.signedBinding, path: row.path, signedContent: await blob.text() });
  }) });
  http.route({ path: "/review-artifacts/metadata", method: "POST", handler: httpAction(async (ctx, request) => {
    if (!await isAuthorized(request)) return new Response(null, { status: 401 });
    const parsed = z.strictObject({ attemptId: z.string().min(1) }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response(null, { status: 400 });
    return Response.json(await ctx.runQuery(internal.artifactData.metadata, parsed.data));
  }) });
  http.route({ path: "/review-artifacts/list", method: "POST", handler: httpAction(async (ctx, request) => {
    if (!await isAuthorized(request)) return new Response(null, { status: 401 });
    const parsed = z.strictObject({ attemptId: z.string().min(1), cursor: z.string().nullable() }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response(null, { status: 400 });
    return Response.json(await ctx.runQuery(internal.artifactData.list, { attemptId: parsed.data.attemptId, paginationOpts: { numItems: 100, cursor: parsed.data.cursor } }));
  }) });
}
