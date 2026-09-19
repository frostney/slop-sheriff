import { z } from "zod";
import type { HttpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { costObservationSchema, costReportRequestSchema } from "../src/telemetry/cost-ledger";

export function registerCostLedgerRoutes(http: HttpRouter, isAuthorized: (request: Request) => Promise<boolean>): void {
  http.route({ path: "/cost/record", method: "POST", handler: httpAction(async (ctx, request) => {
    if (!await isAuthorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const parsed = costObservationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    const { nonbillableFailure, ...observation } = parsed.data;
    await ctx.runMutation(internal.costLedgerData.record, { observation: { ...observation, ...(nonbillableFailure ? { nonbillableFailure } : {}) } });
    return Response.json({ recorded: true });
  }) });
  http.route({ path: "/cost/nonbillable-attempt", method: "POST", handler: httpAction(async (ctx, request) => {
    if (!await isAuthorized(request)) return new Response(null, { status: 401 });
    const parsed = z.object({ attemptId: z.string().min(1), cursor: z.string().nullable() }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return new Response(null, { status: 400 });
    return Response.json(await ctx.runQuery(internal.costLedgerData.nonbillableAttempt, { attemptId: parsed.data.attemptId, paginationOpts: { numItems: 100, cursor: parsed.data.cursor } }));
  }) });
  http.route({ path: "/cost/report", method: "POST", handler: httpAction(async (ctx, request) => {
    if (!await isAuthorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
    const parsed = costReportRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });
    return Response.json(await ctx.runQuery(internal.costLedgerData.report, {
      repositoryId: parsed.data.repositoryId, pullRequest: parsed.data.pullRequest,
      paginationOpts: { numItems: 100, cursor: parsed.data.cursor },
    }));
  }) });
}
