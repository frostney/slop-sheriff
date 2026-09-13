import { defineState } from "eve/context";
import { costServiceConfigured, persistCostObservation } from "../../src/telemetry/cost-client";
import type { CostObservation } from "../../src/telemetry/cost-ledger";
import type { CostExecutionScope } from "../../src/telemetry/sdk-cost-telemetry";
import { assertReviewOwnership } from "../../src/lifecycle/client";

export const costExecutionScope = defineState<CostExecutionScope | null>("slop-sheriff.cost-scope.v1", () => null);
const costOutbox = defineState<readonly CostObservation[]>("slop-sheriff.cost-outbox.v1", () => []);

export async function recordDurableCost(observation: CostObservation): Promise<void> {
  // Fence every provider invocation, including SDK retries and compaction.
  // Cancellation cannot retract a request already accepted by the provider.
  if (observation.outcome === "started") await assertReviewOwnership({ deliveryId: observation.attemptId });
  costOutbox.update(rows => [...rows.filter(row => row.eventId !== observation.eventId), observation]);
  await persistCostObservation(observation);
  costOutbox.update(rows => rows.filter(row => row.eventId !== observation.eventId));
}
export async function flushDurableCosts(): Promise<void> {
  if (!costServiceConfigured()) return;
  for (const row of costOutbox.get()) await recordDurableCost(row);
}
