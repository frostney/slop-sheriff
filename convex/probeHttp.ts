import type { HttpRouter } from "convex/server";
import { z } from "zod";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const claimInput = z.strictObject({
  attemptId: z.string().min(1),
  path: z.string().regex(/^\/tmp\/known-good-review\/probes\/[a-f0-9]{64}$/),
  owner: z.string().uuid(),
});

export function registerProbeRoutes(http: HttpRouter, isAuthorized: (request: Request) => Promise<boolean>): void {
  for (const operation of ["claim", "release", "fail", "assert-healthy", "assert-current"] as const) {
    http.route({ path: `/review-artifacts/probe-${operation}`, method: "POST", handler: httpAction(async (ctx, request) => {
      if (!await isAuthorized(request)) return new Response(null, { status: 401 });
      const body: unknown = await request.json().catch(() => null);
      if (operation === "assert-current") {
        const input = z.strictObject({ attemptId: z.string().min(1) }).safeParse(body);
        if (!input.success) return new Response(null, { status: 400 });
        return Response.json(await ctx.runQuery(internal.probeData.assertCurrent, input.data));
      }
      const input = claimInput.safeParse(body);
      if (!input.success) return new Response(null, { status: 400 });
      if (operation === "fail") return Response.json(await ctx.runMutation(internal.probeData.fail, input.data));
      if (operation === "assert-healthy") return Response.json(await ctx.runQuery(internal.probeData.assertHealthy, input.data));
      return Response.json(operation === "claim"
        ? await ctx.runMutation(internal.probeData.claim, input.data)
        : await ctx.runMutation(internal.probeData.release, input.data));
    }) });
  }
}
