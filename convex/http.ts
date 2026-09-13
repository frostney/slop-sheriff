import { registerArtifactRoutes } from "./artifactHttp";
import { registerCostLedgerRoutes } from "./costLedgerHttp";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { z } from "zod";
import {
  memoryDeletionSchema,
  memoryAdmissionRequestSchema,
  memoryIngestionSchema,
  memorySearchRequestSchema,
} from "../src/memory/contracts";

import { lifecycleAdmissionSchema } from "../src/lifecycle/contracts";

const http = httpRouter();

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function isAuthorized(request: Request): Promise<boolean> {
  const expected = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  const authorization = request.headers.get("authorization");
  if (!expected || !authorization?.startsWith("Bearer ")) return false;
  const [actualDigest, expectedDigest] = await Promise.all([
    digest(authorization.slice("Bearer ".length)),
    digest(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |=
      (actualDigest.at(index) ?? 0) ^ (expectedDigest.at(index) ?? 0);
  }
  return difference === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function requestBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | null> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

http.route({
  path: "/memory/admission",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
    const admission = await requestBody(request, memoryAdmissionRequestSchema);
    if (!admission) return json({ error: "invalid_request" }, 400);
    return json(await ctx.runMutation(internal.memoryAccess.captureAdmission, admission));
  }),
});

http.route({
  path: "/memory/ingest",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
    const ingestion = await requestBody(request, memoryIngestionSchema);
    if (!ingestion) return json({ error: "invalid_request" }, 400);
    if (!ingestion.memoryAdmission) return json({ error: "memory_admission_required" }, 409);
    const queued = await ctx.runMutation(
      internal.memoryData.queueReview,
      { ...ingestion, memoryAdmission: ingestion.memoryAdmission },
    );
    return json(queued, queued.status === "revoked" ? 409 : 202);
  }),
});

http.route({
  path: "/memory/search",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
    const search = await requestBody(request, memorySearchRequestSchema);
    if (!search) return json({ error: "invalid_request" }, 400);
    return json(
      await ctx.runAction(internal.memoryActions.searchRepository, search),
    );
  }),
});

http.route({
  path: "/memory/delete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
    const deletion = await requestBody(request, memoryDeletionSchema);
    if (!deletion) return json({ error: "invalid_request" }, 400);
    if (deletion.kind === "repositories") {
      for (let start = 0; start < deletion.repositoryIds.length; start += 100) {
        await ctx.runMutation(internal.memoryData.beginRepositoriesDeletion, {
          installationId: deletion.installationId,
          deliveryId: deletion.deliveryId,
          repositoryIds: deletion.repositoryIds.slice(start, start + 100),
        });
      }
    } else {
      await ctx.runMutation(
        internal.memoryData.reconcileInstallationRepositories,
        {
          installationId: deletion.installationId,
          deliveryId: deletion.deliveryId,
          uninstalled: deletion.uninstalled,
          phase: "access",
          retainedRepositoryIds: deletion.retainedRepositoryIds,
          cursor: null,
        },
      );
    }
    return json({ accepted: true }, 202);
  }),
});

http.route({ path: "/review-lifecycle/stage", method: "POST", handler: httpAction(async (ctx, request) => {
  if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
  const parsed = z.object({ attemptId: z.string(), kind: z.enum(["report", "failure"]), publication: z.string(), interruption: z.string().optional() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const storageId = await ctx.storage.store(new Blob([parsed.data.publication], { type: "application/json" }));
  const publication = JSON.stringify({ storageId });
  const accepted = await ctx.runMutation(internal.reviewLifecycle.stage, { attemptId: parsed.data.attemptId, kind: parsed.data.kind, publication, ...(parsed.data.interruption ? { interruption: parsed.data.interruption } : {}) });
  const retained = await ctx.runQuery(internal.reviewLifecycle.inspect, { attemptId: parsed.data.attemptId });
  if (!accepted || retained?.publication !== publication) await ctx.storage.delete(storageId);
  return json(accepted);
}) });
http.route({ path: "/review-lifecycle/publication", method: "POST", handler: httpAction(async (ctx, request) => {
  if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
  const parsed = z.object({ attemptId: z.string() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const row = await ctx.runQuery(internal.reviewLifecycle.inspect, parsed.data);
  if (!row?.publication) return json({ error: "publication_missing" }, 404);
  const stored = z.object({ storageId: z.string() }).safeParse(JSON.parse(row.publication));
  if (!stored.success) return new Response(row.publication, { headers: { "content-type": "application/json" } });
  const blob = await ctx.storage.get(stored.data.storageId as import("./_generated/dataModel").Id<"_storage">);
  return blob ? new Response(blob, { headers: { "content-type": "application/json" } }) : json({ error: "publication_missing" }, 404);
}) });

const lifecycleOperations = {
  admit: { schema: lifecycleAdmissionSchema, ref: internal.reviewLifecycle.admit },
  claim: { schema: z.object({ capacity: z.number().int().positive().max(100) }), ref: internal.reviewLifecycle.claim },
  inspect: { schema: z.object({ attemptId: z.string(), includeSuperseded: z.boolean().optional() }), ref: internal.reviewLifecycle.inspect, query: true },
  fence: { schema: z.object({ attemptId: z.string() }), ref: internal.reviewLifecycle.fence, query: true },
  activate: { schema: z.object({ attemptId: z.string(), headSha: z.string(), repositoryId: z.string().optional(), sessionId: z.string().optional(), continuationAddress: z.string().optional(), previousSessionId: z.string().optional(), trustedContext: z.string().optional(), recoveryAuth: z.string().optional() }), ref: internal.reviewLifecycle.activate },
  heartbeat: { schema: z.object({ attemptId: z.string(), sessionId: z.string().optional(), workerSessionId: z.string().optional() }), ref: internal.reviewLifecycle.heartbeat },
  claimHeadVerifications: { schema: z.object({}), ref: internal.reviewLifecycle.claimHeadVerifications },
  verifyHead: { schema: z.object({ deliveryId: z.string(), currentHead: z.string().nullable() }), ref: internal.reviewLifecycle.verifyHead },
  owner: { schema: z.object({ repositoryId: z.string(), pullRequest: z.number() }), ref: internal.reviewLifecycle.owner, query: true },
  stop: { schema: z.object({ attemptId: z.string() }), ref: internal.reviewLifecycle.stop },
  claimInterruptions: { schema: z.object({}), ref: internal.reviewLifecycle.claimInterruptions },
  recover: { schema: z.object({ attemptId: z.string(), evidenceEligible: z.boolean(), prerequisiteReady: z.boolean(), discardPriorEvidence: z.boolean().optional(), progressDigest: z.string().optional() }), ref: internal.reviewLifecycle.recover },
  claimQueueNotices: { schema: z.object({}), ref: internal.reviewLifecycle.claimQueueNotices },
  finishQueueNotice: { schema: z.object({ deliveryId: z.string(), delivered: z.boolean(), cancelled: z.boolean().optional() }), ref: internal.reviewLifecycle.finishQueueNotice },
  claimCancellations: { schema: z.object({}), ref: internal.reviewLifecycle.claimCancellations, query: true },
  cancelled: { schema: z.object({ attemptId: z.string() }), ref: internal.reviewLifecycle.cancelled },
  claimReconciliation: { schema: z.object({}), ref: internal.reviewLifecycle.claimReconciliation },
  claimPublications: { schema: z.object({}), ref: internal.reviewLifecycle.claimPublications },
  finish: { schema: z.object({ attemptId: z.string(), outcome: z.enum(["complete", "delivered", "retry", "interrupted"]), failureCode: z.string().optional(), interruption: z.string().optional() }), ref: internal.reviewLifecycle.finish },
} as const;
for (const [operation, definition] of Object.entries(lifecycleOperations)) {
  http.route({ path: `/review-lifecycle/${operation}`, method: "POST", handler: httpAction(async (ctx, request) => {
    if (!(await isAuthorized(request))) return json({ error: "unauthorized" }, 401);
    const parsed = definition.schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: "invalid_request" }, 400);
    // The operation map couples each runtime validator to its registered Convex validator.
    const result = "query" in definition
      ? await ctx.runQuery(definition.ref, parsed.data as never)
      : await ctx.runMutation(definition.ref, parsed.data as never);
    return json(result);
  }) });
}

registerCostLedgerRoutes(http, isAuthorized);
registerArtifactRoutes(http, isAuthorized);

export default http;
