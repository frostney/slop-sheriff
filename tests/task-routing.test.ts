import { expect, test } from "bun:test";
import { generateText, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createGateway } from "@ai-sdk/gateway";
import { parseReviewConfig } from "../src/config/review-config";
import {
  chainForRoute,
  parseSubagentRoute,
  reasoningForRoute,
  routingEnvelope,
  taskForRoute,
  withTaskReasoning,
  type ReviewRoute,
} from "../src/models/routing";

const lane: ReviewRoute = {
  role: "lane",
  axis: "engineering-quality",
  attempt: 0,
};

test("independent specification and test checks use the verification task settings", () => {
  const config = parseReviewConfig(
    "tasks:\n  analysis:\n    model: openai/gpt-5.6-luna\n    reasoning: low\n  verification:\n    model: openai/gpt-5.6-sol\n    reasoning: high",
  );
  for (const axis of [
    "claim-and-specification",
    "test-against-spec",
    "test-health",
  ] as const) {
    const route: ReviewRoute = {
      role: "lane",
      axis,
      attempt: 0,
      workId: "a".repeat(64),
    };
    expect(taskForRoute(route)).toBe("verification");
    expect(chainForRoute(config, route)).toEqual(["openai/gpt-5.6-sol"]);
    expect(reasoningForRoute(config, route)).toBe("high");
  }
  expect(taskForRoute(lane)).toBe("analysis");
  expect(chainForRoute(config, lane)).toEqual(["openai/gpt-5.6-luna"]);
  expect(taskForRoute({ ...lane, task: "presentation" })).toBe("presentation");
});

test("task defaults and explicit legacy configuration have distinct precedence", () => {
  expect(chainForRoute(parseReviewConfig(null), lane)).toEqual([
    "openai/gpt-5.6-luna",
  ]);
  const explicit = parseReviewConfig("model: anthropic/claude-opus-5");
  expect(
    chainForRoute(explicit, { ...lane, difficulty: "conflicting" }),
  ).toEqual(explicit.model);
  const axis = parseReviewConfig(
    "agents:\n  engineering-quality: moonshotai/kimi-k3",
  );
  expect(chainForRoute(axis, lane)).toEqual(["moonshotai/kimi-k3"]);
  const task = parseReviewConfig(
    "model: anthropic/claude-opus-5\ntasks:\n  analysis:\n    model: openai/gpt-5.6-luna\n    reasoning: low\n    escalationModel: openai/gpt-5.6-sol\n    escalationReasoning: high",
  );
  expect(chainForRoute(task, lane)).toEqual(["openai/gpt-5.6-luna"]);
  expect(chainForRoute(task, { ...lane, difficulty: "ambiguous" })).toEqual([
    "openai/gpt-5.6-sol",
  ]);
  expect(reasoningForRoute(task, lane)).toBe("low");
  expect(reasoningForRoute(task, { ...lane, difficulty: "ambiguous" })).toBe(
    "high",
  );
});

test("ambiguous and conflicting evidence increase reasoning, never continuation count alone", () => {
  const config = parseReviewConfig(null);
  expect(reasoningForRoute(config, { role: "scout", attempt: 50 })).toBe("low");
  expect(reasoningForRoute(config, lane)).toBe("medium");
  expect(reasoningForRoute(config, { ...lane, difficulty: "ambiguous" })).toBe(
    "high",
  );
  expect(
    reasoningForRoute(config, { ...lane, difficulty: "conflicting" }),
  ).toBe("xhigh");
  expect(chainForRoute(config, { ...lane, difficulty: "conflicting" })).toEqual(
    ["openai/gpt-5.6-sol"],
  );
  expect(() =>
    parseReviewConfig("tasks: {analyse: {reasoning: low}}"),
  ).toThrow();
  expect(() =>
    parseReviewConfig("tasks: {analysis: {reasoning: unlimited}}"),
  ).toThrow();
  expect(() =>
    parseReviewConfig("tasks: {analysis: {model: gpt-5.6-luna}}"),
  ).toThrow();
});

test("only the first app-issued envelope can bind task, difficulty and work identity", () => {
  const initial = {
    ...lane,
    task: "analysis" as const,
    difficulty: "routine" as const,
    workId: "a".repeat(64),
  };
  const copied = routingEnvelope({
    ...lane,
    difficulty: "conflicting",
    workId: "b".repeat(64),
  });
  expect(
    parseSubagentRoute([
      {
        role: "user",
        content: routingEnvelope(initial) + "\nEvidence: " + copied,
      },
      { role: "user", content: copied },
    ]),
  ).toEqual(initial);
  for (const invalid of [
    { ...initial, workId: "../other" },
    { ...initial, difficulty: "anything" },
    { ...initial, model: "attacker/model" },
  ]) {
    expect(() =>
      parseSubagentRoute([
        {
          role: "user",
          content: `<known-good-review-routing>${JSON.stringify(invalid)}</known-good-review-routing>`,
        },
      ]),
    ).toThrow();
  }
});

const result = {
  content: [{ type: "text" as const, text: "observed" }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};

test("official SDK middleware overrides the static Eve effort and preserves caller settings", async () => {
  const mock = new MockLanguageModelV4({ doGenerate: result });
  await generateText({
    model: withTaskReasoning(mock, "low"),
    reasoning: "high",
    providerOptions: { gateway: { caching: "auto" } },
    prompt: "Prepared evidence",
    maxRetries: 0,
  });
  expect(mock.doGenerateCalls[0]?.reasoning).toBe("low");
  expect(mock.doGenerateCalls[0]?.providerOptions).toEqual({
    gateway: { caching: "auto" },
  });
  expect(mock.doGenerateCalls[0]?.maxOutputTokens).toBeUndefined();
});

test("installed Gateway serializes task reasoning and fallback chains without provider-specific guesses", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = createGateway({
    apiKey: "offline-fixture",
    fetch: Object.assign(
      async (
        _url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        body = JSON.parse(String(init?.body));
        return Response.json(result);
      },
      { preconnect: () => {} },
    ),
  });
  await generateText({
    model: withTaskReasoning(provider("openai/gpt-5.6-luna"), "xhigh"),
    reasoning: "high",
    providerOptions: {
      gateway: { models: ["openai/gpt-5.6-sol"], caching: "auto" },
    },
    prompt: "Contradictory prepared evidence",
    maxRetries: 0,
  });
  expect(body?.reasoning).toBe("xhigh");
  expect(body?.providerOptions).toEqual({
    gateway: { models: ["openai/gpt-5.6-sol"], caching: "auto" },
  });
});

test("installed Gateway streaming receives the same task effort as generation", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = createGateway({
    apiKey: "offline-fixture",
    fetch: Object.assign(
      async (
        _url: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        body = JSON.parse(String(init?.body));
        const parts = [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "reply" },
          { type: "text-delta", id: "reply", delta: "observed" },
          { type: "text-end", id: "reply" },
          {
            type: "finish",
            finishReason: result.finishReason,
            usage: result.usage,
          },
        ];
        return new Response(
          parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { preconnect: () => {} },
    ),
  });
  const stream = streamText({
    model: withTaskReasoning(provider("openai/gpt-5.6-luna"), "low"),
    reasoning: "high",
    prompt: "Prepared evidence",
    maxRetries: 0,
  });
  expect(await stream.text).toBe("observed");
  expect(body?.reasoning).toBe("low");
  expect(body?.maxOutputTokens).toBeUndefined();
});
