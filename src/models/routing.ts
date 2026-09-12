import type { ModelMessage } from "ai";
import {
  parseReviewConfig,
  modelsForAxis,
  modelsForSpecialist,
  type ModelChain,
  type ReviewConfig,
} from "../config/review-config";
import { isReviewAxis, type ReviewAxis } from "../review/axes";

import { assertConfiguredLane } from "../review/project-lanes";

export const routingAttribute = "known_good_review_config";
const routingPattern =
  /^<known-good-review-routing>(\{[^<\n]+\})<\/known-good-review-routing>/;
// Eve's built-in agent wraps the initial caller message before delivering it
// to the model resolver. Match the complete wrapper, never an embedded marker.
// The installed-SDK regression test guards this version-dependent boundary.
const eveAgentCallerPrefix = [
  'You are the subagent "agent".',
  "",
  "The caller delegated the following task to you. Complete it and return the result directly. The caller may send follow-up messages after you answer.",
  "",
  "Caller message:",
  "",
].join("\n");

export type ReviewRoute =
  | { readonly role: "coordinator"; readonly attempt: number }
  | { readonly role: "lane"; readonly axis: ReviewAxis; readonly attempt: number }
  | { readonly role: "revalidation"; readonly attempt: number }
  | { readonly role: "scout"; readonly attempt: number };

function textFromMessage(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .map((part) => {
      if (typeof part === "object" && part !== null && "text" in part) {
        return typeof part.text === "string" ? part.text : "";
      }
      return "";
    })
    .join("\n");
}

function parseAttempt(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error("Review routing attempt must be a non-negative integer");
  }
  return value as number;
}

export function parseSubagentRoute(messages: readonly ModelMessage[]): ReviewRoute {
  // Only the initial delegation owns routing. Later evidence and model output
  // can contain copied envelopes and must never change the lane or its model.
  const delegation = messages.find((message) => message.role === "user");
  const text = delegation ? textFromMessage(delegation) : "";
  const callerMessage = text.startsWith(eveAgentCallerPrefix)
    ? text.slice(eveAgentCallerPrefix.length)
    : text;
  const encoded = routingPattern.exec(callerMessage)?.[1];
  if (!encoded) {
    throw new Error("Review subagent message is missing its routing envelope");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error("Review subagent routing envelope is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || !("role" in parsed)) {
    throw new Error("Review subagent routing envelope is malformed");
  }
  const role = parsed.role;
  const attempt = parseAttempt("attempt" in parsed ? parsed.attempt : 0);
  if (role === "revalidation" || role === "scout") {
    return { role, attempt };
  }
  if (role === "lane" && "axis" in parsed && typeof parsed.axis === "string") {
    if (!isReviewAxis(parsed.axis)) {
      throw new Error(`Unknown review axis ${JSON.stringify(parsed.axis)}`);
    }
    return { role, axis: parsed.axis, attempt };
  }
  throw new Error(
    "Review subagent routing role must be lane, revalidation, or scout",
  );
}

export function chainForRoute(
  config: ReviewConfig,
  route: ReviewRoute,
): ModelChain {
  if (route.role === "lane") {
    assertConfiguredLane(route.axis, config);
    return modelsForAxis(config, route.axis);
  }
  if (route.role === "scout") {
    return modelsForSpecialist(config, route.role);
  }
  if (route.role === "revalidation" && config.agents.kind === "all") {
    return config.agents.models;
  }
  return config.model;
}

export function selectRoutedModel(input: {
  readonly route?: ReviewRoute;
  readonly attributes: Readonly<
    Record<string, string | readonly string[]>
  > | null;
  readonly channelKind: string | undefined;
  readonly messages: readonly ModelMessage[];
}): {
  readonly model: string;
  readonly modelOptions?: {
    readonly providerOptions: {
      readonly gateway: {
        readonly caching: "auto";
        readonly models?: readonly string[];
      };
      readonly openai?: {
        readonly reasoningEffort: "xhigh";
      };
    };
  };
} {
  const rawConfig = input.attributes?.[routingAttribute];
  const config =
    typeof rawConfig === "string"
      ? parseReviewConfig(rawConfig)
      : parseReviewConfig(null);
  const route: ReviewRoute = input.route ?? (
    input.channelKind === "subagent"
      ? parseSubagentRoute(input.messages)
      : { role: "coordinator", attempt: 0 });
  const chain = chainForRoute(config, route);
  // Attempts count fresh checkpoint continuations. Gateway owns failover
  // within each invocation, independently of the number of evidence packets.
  const model = chain[0];
  const fallbacks = chain.slice(1);
  const gatewayOptions = {
    caching: "auto" as const,
    ...(fallbacks.length > 0 ? { models: fallbacks } : {}),
  };
  const specialistOpenAi =
    route.role === "scout" && model.startsWith("openai/");
  return {
    model,
    modelOptions: {
      providerOptions: {
        gateway: gatewayOptions,
        ...(specialistOpenAi
          ? { openai: { reasoningEffort: "xhigh" } }
          : {}),
      },
    },
  };
}

export function routingEnvelope(route: Exclude<ReviewRoute, { role: "coordinator" }>): string {
  return `<known-good-review-routing>${JSON.stringify(route)}</known-good-review-routing>`;
}
