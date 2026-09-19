import { defineAgent, defineDynamic } from "eve";
import { gateway } from "ai";
import { currentReviewRoute } from "./lib/review-route";
import { selectRoutedModel, selectRoutedReasoning, withTaskReasoning } from "../src/models/routing";

export default defineAgent({
  defaultTools: true,
  experimental: { instrumentationProviders: true },
  model: defineDynamic({
    events: {
      "step.started": (_event, ctx) => {
        const input = {
          route: currentReviewRoute(ctx.channel.kind, ctx.messages),
          attributes: ctx.session.auth.current?.attributes ?? null,
          channelKind: ctx.channel.kind,
          messages: ctx.messages,
        };
        const selected = selectRoutedModel(input);
        return { ...selected, model: withTaskReasoning(gateway(selected.model), selectRoutedReasoning(input)) };
      },
    },
  }),
  limits: { maxInputTokensPerSession: false },
  compaction: {
    thresholdPercent: 0.25,
  },
  reasoning: "high",
});
