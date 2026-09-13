import { defineInstrumentation } from "eve/instrumentation";
import { registerTelemetry } from "ai";
import { createCostTelemetry } from "../../src/telemetry/sdk-cost-telemetry";
import { costServiceConfigured } from "../../src/telemetry/cost-client";
import { costExecutionScope, recordDurableCost, flushDurableCosts } from "../lib/cost-ledger";

const integration = createCostTelemetry({
  scope: () => costServiceConfigured() ? costExecutionScope.get() : null,
  record: recordDurableCost,
});

export default defineInstrumentation({
  tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
  setup() {
    if (!globalThis.AI_SDK_TELEMETRY_INTEGRATIONS?.includes(integration)) registerTelemetry(integration);
  },
  flush: flushDurableCosts,
});
