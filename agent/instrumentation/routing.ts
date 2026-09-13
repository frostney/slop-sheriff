import { otelIntegration } from "eve/instrumentation/otel";
import { readReviewRoute } from "../lib/review-route";
import { parseReviewConfig } from "../../src/config/review-config";
import {
  chainForRoute,
  taskForRoute,
  routingAttribute,
} from "../../src/models/routing";

export default otelIntegration({
  runtimeContext(input) {
    const rawConfig =
      input.session.auth.current?.attributes[routingAttribute];
    const config = parseReviewConfig(
      typeof rawConfig === "string" ? rawConfig : null,
    );
    const route = readReviewRoute(input.channel.kind, input.modelInput.messages);
    if (!route) return {
      "review.role": input.channel.kind === "subagent" ? "unknown" : "coordinator",
      "review.task": "unknown",
    };
    const chain = chainForRoute(config, route);
    return {
      "review.role": route.role,
      "review.task": taskForRoute(route),
      "review.axis": route.role === "lane" ? route.axis : route.role,
      "review.requested_model": chain[0],
      "review.fallback_models": chain.slice(1),
    };
  },
});
