import { wrapLanguageModel, type LanguageModel, type ModelMessage } from "ai";
import { z } from "zod";
import {
  parseReviewConfig,
  modelsForAxis,
  modelsForSpecialist,
  type ModelChain,
  type ReviewConfig,
  reviewTasks,
  type ReviewTask,
  type ReviewReasoning,
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

export type ReviewRoute = (
  | { readonly role: "coordinator"; readonly attempt: number }
  | {
      readonly role: "lane";
      readonly axis: ReviewAxis;
      readonly attempt: number;
      readonly workId?: string;
    }
  | { readonly role: "revalidation"; readonly attempt: number }
  | { readonly role: "scout"; readonly attempt: number }
) & {
  readonly task?: ReviewTask;
  readonly difficulty?: "routine" | "ambiguous" | "conflicting";
};

const routeTaskSchema = z.object({
  task: z.enum(reviewTasks).optional(),
  difficulty: z.enum(["routine", "ambiguous", "conflicting"]).optional(),
});

/** Candidate defaults, pending real-model evaluation. These are not spending limits. */
export const taskRoutingDefaults = {
  triage: { model: ["openai/gpt-5.6-luna"], reasoning: "low" },
  analysis: { model: ["openai/gpt-5.6-luna"], reasoning: "medium" },
  verification: { model: ["openai/gpt-5.6-luna"], reasoning: "medium" },
  adjudication: { model: ["openai/gpt-5.6-luna"], reasoning: "medium" },
  presentation: { model: ["openai/gpt-5.6-luna"], reasoning: "low" },
} as const satisfies Record<
  ReviewTask,
  { model: ModelChain; reasoning: ReviewReasoning }
>;

export function taskForRoute(route: ReviewRoute): ReviewTask {
  if (route.task) return route.task;
  if (route.role === "coordinator") return "adjudication";
  if (route.role === "scout") return "triage";
  if (route.role === "revalidation") return "verification";
  return [
    "claim-and-specification",
    "test-against-spec",
    "test-health",
  ].includes(route.axis)
    ? "verification"
    : "analysis";
}

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

export function parseSubagentRoute(
  messages: readonly ModelMessage[],
): ReviewRoute {
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
  const taskData = routeTaskSchema.parse(parsed);
  const extras = {
    ...(taskData.task ? { task: taskData.task } : {}),
    ...(taskData.difficulty ? { difficulty: taskData.difficulty } : {}),
  };
  const allowed = new Set([
    "role",
    "attempt",
    "task",
    "difficulty",
    ...(role === "lane" ? ["axis", "workId"] : []),
  ]);
  if (Object.keys(parsed).some((key) => !allowed.has(key)))
    throw new Error("Unknown review routing field");
  if (role === "revalidation" || role === "scout") {
    return { role, attempt, ...extras };
  }
  if (role === "lane" && "axis" in parsed && typeof parsed.axis === "string") {
    if (!isReviewAxis(parsed.axis)) {
      throw new Error(`Unknown review axis ${JSON.stringify(parsed.axis)}`);
    }
    const workId =
      "workId" in parsed
        ? z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(parsed.workId)
        : undefined;
    return {
      role,
      axis: parsed.axis,
      attempt,
      ...(workId ? { workId } : {}),
      ...extras,
    };
  }
  throw new Error(
    "Review subagent routing role must be lane, revalidation, or scout",
  );
}

export function chainForRoute(
  config: ReviewConfig,
  route: ReviewRoute,
): ModelChain {
  const task = taskForRoute(route);
  const settings = config.tasks?.[task];
  const escalated =
    route.difficulty === "ambiguous" || route.difficulty === "conflicting";
  if (route.role === "lane") assertConfiguredLane(route.axis, config);
  if (escalated && settings?.escalationModel) return settings.escalationModel;
  if (settings?.model) return settings.model;
  const hasAgentOverride =
    (config.agents.kind === "all" && route.role !== "coordinator") ||
    (config.agents.kind === "axes" &&
      ((route.role === "lane" &&
        config.agents.models[route.axis] !== undefined) ||
        (route.role === "scout" && config.agents.models.scout !== undefined)));
  if (config.modelConfigured === false && !hasAgentOverride) {
    return escalated ? ["openai/gpt-5.6-sol"] : taskRoutingDefaults[task].model;
  }
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

export interface RoutedModelInput {
  readonly route?: ReviewRoute;
  readonly attributes: Readonly<
    Record<string, string | readonly string[]>
  > | null;
  readonly channelKind: string | undefined;
  readonly messages: readonly ModelMessage[];
}

function routeAndConfig(input: RoutedModelInput) {
  const rawConfig = input.attributes?.[routingAttribute];
  const config = parseReviewConfig(
    typeof rawConfig === "string" ? rawConfig : null,
  );
  const route: ReviewRoute =
    input.route ??
    (input.channelKind === "subagent"
      ? parseSubagentRoute(input.messages)
      : { role: "coordinator", attempt: 0 });
  routeTaskSchema.parse(route);
  return { config, route };
}

export function reasoningForRoute(
  config: ReviewConfig,
  route: ReviewRoute,
): ReviewReasoning {
  const task = taskForRoute(route);
  const settings = config.tasks?.[task];
  const ordinary = settings?.reasoning ?? taskRoutingDefaults[task].reasoning;
  if (route.difficulty !== "ambiguous" && route.difficulty !== "conflicting")
    return ordinary;
  const escalation =
    settings?.escalationReasoning ??
    (route.difficulty === "conflicting" ? "xhigh" : "high");
  const rank = [
    "provider-default",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ];
  // Ambiguous evidence always receives at least high effort, even if a project
  // accidentally configures its escalation below the ordinary effort.
  return rank[
    Math.max(
      rank.indexOf(ordinary),
      rank.indexOf(escalation),
      rank.indexOf("high"),
    )
  ] as ReviewReasoning;
}

export function selectRoutedReasoning(
  input: RoutedModelInput,
): ReviewReasoning {
  const { config, route } = routeAndConfig(input);
  return reasoningForRoute(config, route);
}

/** Official SDK boundary sets task effort after Eve's static agent default. */
export function withTaskReasoning(
  model: LanguageModel,
  reasoning: ReviewReasoning,
) {
  return wrapLanguageModel({
    model: model as Exclude<LanguageModel, string>,
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({ ...params, reasoning,
        // Eve's authored ToolDefinition has no strict option. Set the official
        // SDK flag at its model boundary for the audited object/variant schemas.
        ...(params.tools ? { tools: params.tools.map(tool => tool.type === "function" &&
          ["review_work", "inspect_review_source"].includes(tool.name) ? { ...tool, strict: true } : tool) } : {}),
      }),
    },
  });
}

export function selectRoutedModel(input: RoutedModelInput): {
  readonly model: string;
  readonly modelOptions?: {
    readonly providerOptions: {
      readonly gateway: {
        readonly caching: "auto";
        readonly models?: readonly string[];
      };
    };
  };
} {
  const { config, route } = routeAndConfig(input);
  const chain = chainForRoute(config, route);
  // Attempts count fresh checkpoint continuations. Gateway owns failover
  // within each invocation, independently of the number of evidence packets.
  const model = chain[0];
  const fallbacks = chain.slice(1);
  const gatewayOptions = {
    caching: "auto" as const,
    ...(fallbacks.length > 0 ? { models: fallbacks } : {}),
  };
  return {
    model,
    modelOptions: {
      providerOptions: {
        gateway: gatewayOptions,
      },
    },
  };
}

export function routingEnvelope(
  route: Exclude<ReviewRoute, { role: "coordinator" }>,
): string {
  return `<known-good-review-routing>${JSON.stringify(route)}</known-good-review-routing>`;
}
