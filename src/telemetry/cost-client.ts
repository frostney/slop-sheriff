import { z } from "zod";
import { costObservationSchema, costReportPageSchema, costLifecycleReport, type CostObservation, type CostReportRow } from "./cost-ledger";

export function costServiceConfigured(): boolean {
  return Boolean(process.env.CONVEX_MEMORY_URL && process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN);
}
async function post(path: string, body: unknown): Promise<Response> {
  const base = process.env.CONVEX_MEMORY_URL?.replace(/\/$/, "");
  const token = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  if (!base || !token) throw new Error("Durable cost service is not configured");
  const response = await fetch(`${base}${path}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Durable cost service returned HTTP ${response.status}`);
  return response;
}
export async function persistCostObservation(observation: CostObservation): Promise<void> {
  await post("/cost/record", costObservationSchema.parse(observation));
}
export async function readCostReport(repositoryId: string, pullRequest: number) {
  const rows: CostReportRow[] = [];
  let cursor: string | null = null;
  do {
    const page = costReportPageSchema.parse(await (await post("/cost/report", { repositoryId, pullRequest, cursor })).json());
    rows.push(...page.rows);
    cursor = page.cursor;
  } while (cursor !== null);
  return { repositoryId, pullRequest, ...costLifecycleReport(rows) };
}

export async function proveNonbillableAttempt(attemptId: string): Promise<boolean> {
  let cursor: string | null = null;
  let observed = 0;
  let rejected = 0;
  do {
    const page = z.object({ observedCalls: z.number().int().nonnegative(), rejectedCalls: z.number().int().nonnegative(), cursor: z.string().nullable() }).parse(await (await post("/cost/nonbillable-attempt", { attemptId, cursor })).json());
    observed += page.observedCalls;
    rejected += page.rejectedCalls;
    cursor = page.cursor;
  } while (cursor !== null);
  return observed > 0 && observed === rejected;
}
