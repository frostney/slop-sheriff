import type { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
export function registerCostLedgerCron(crons: ReturnType<typeof cronJobs>): void {
  crons.interval("reconcile-review-costs", { minutes: 1 }, internal.costLedgerActions.sweep, {});
}
