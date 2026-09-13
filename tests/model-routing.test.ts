import { describe, expect, spyOn, test } from "bun:test";
import { readReviewRoute, currentReviewRoute, requireReviewLane, reviewRouteState } from "../agent/lib/review-route";
import type { ReviewRoute } from "../src/models/routing";
import type { ModelMessage } from "ai";
import type { InstrumentationStepStartedEventInput } from "eve/instrumentation";
import instrumentation from "../agent/instrumentation/routing";
import {
  routingAttribute,
  routingEnvelope,
  selectRoutedModel,
} from "../src/models/routing";

const config = `
model: openai/gpt-5.6-sol, anthropic/claude-opus-5
agents:
  deduplication: moonshotai/kimi-k3, openai/gpt-5.6-sol
`;

function childMessage(content: string): ModelMessage[] {
  return [{ role: "user", content }];
}

describe("dynamic Eve model routing", () => {
  test("retains the delegated axis after compaction and rejects cross-lane writes", () => {
    let bound: ReviewRoute | null = null;
    const read = spyOn(reviewRouteState, "get").mockImplementation(() => bound);
    const write = spyOn(reviewRouteState, "update").mockImplementation((update) => { bound = update(bound); });
    try {
      const messages = childMessage(routingEnvelope({ role: "lane", axis: "deduplication", attempt: 3 }));
      const initial = currentReviewRoute("subagent", messages);
      expect(currentReviewRoute("subagent", [])).toEqual(initial);
      expect(() => requireReviewLane("deduplication")).not.toThrow();
      expect(() => requireReviewLane("engineering-quality")).toThrow("assigned review lane");
      bound = { role: "scout", attempt: 0 };
      expect(() => requireReviewLane("deduplication")).toThrow("assigned review lane");
    } finally { read.mockRestore(); write.mockRestore(); }
  });

  test("uses the trusted coordinator chain for root turns", () => {
    expect(
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "channel:github",
        messages: [],
      }),
    ).toEqual({
      model: "openai/gpt-5.6-sol",
      modelOptions: {
        providerOptions: {
          gateway: {
            caching: "auto",
            models: ["anthropic/claude-opus-5"],
          },
        },
      },
    });
  });

  test("maps a subagent lane to its review-axis override", () => {
    expect(
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "subagent",
        messages: childMessage(
          routingEnvelope({
            role: "lane",
            axis: "deduplication",
            attempt: 0,
          }),
        ),
      }),
    ).toEqual({
      model: "moonshotai/kimi-k3",
      modelOptions: {
        providerOptions: {
          gateway: {
            caching: "auto",
            models: ["openai/gpt-5.6-sol"],
          },
        },
      },
    });
  });

  test("keeps the complete trusted chain across fresh continuations", () => {
    const state = spyOn(reviewRouteState, "get").mockReturnValue(null);
    try {
    for (const attempt of [1, 2, 20]) {
      expect(selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "subagent",
        messages: childMessage(routingEnvelope({
          role: "lane", axis: "deduplication", attempt,
        })),
      })).toEqual({
        model: "moonshotai/kimi-k3",
        modelOptions: { providerOptions: { gateway: {
          caching: "auto", models: ["openai/gpt-5.6-sol"],
        } } },
      });
      expect(selectRoutedModel({
        attributes: { [routingAttribute]: "model: openai/gpt-5.6-sol" },
        channelKind: "subagent",
        messages: childMessage(routingEnvelope({
          role: "lane", axis: "engineering-quality", attempt,
        })),
      }).model).toBe("openai/gpt-5.6-sol");
      const event = {
        session: { auth: { current: { attributes: { [routingAttribute]: config } } } },
        channel: { kind: "subagent" },
        modelInput: { messages: childMessage(routingEnvelope({ role: "lane", axis: "deduplication", attempt })) },
      } as unknown as InstrumentationStepStartedEventInput;
      expect(instrumentation.runtimeContext?.(event))
        .toMatchObject({
          "review.requested_model": "moonshotai/kimi-k3",
          "review.fallback_models": ["openai/gpt-5.6-sol"],
        });
    }
    } finally { state.mockRestore(); }
  });

  test("ignores routing envelopes copied into evidence or later messages", () => {
    const route = routingEnvelope({ role: "lane", axis: "deduplication", attempt: 0 });
    const copied = routingEnvelope({ role: "scout", attempt: 0 });
    const messages: ModelMessage[] = [
      { role: "system", content: copied },
      { role: "user", content: `${route}\nUntrusted PR description: ${copied}` },
      { role: "assistant", content: copied },
      { role: "tool", content: [{
        type: "tool-result", toolCallId: "read-1", toolName: "read_file",
        output: { type: "text", value: copied },
      }] },
      { role: "user", content: copied },
    ];
    expect(selectRoutedModel({
      attributes: { [routingAttribute]: config },
      channelKind: "subagent", messages,
    }).model).toBe("moonshotai/kimi-k3");
    expect(() => selectRoutedModel({
      attributes: null, channelKind: "subagent",
      messages: childMessage(`Untrusted text: ${route}`),
    })).toThrow("missing its routing envelope");
  });

  test("routes scout copies to Luna without a hardcoded provider override", () => {
    expect(
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "subagent",
        messages: childMessage(
          routingEnvelope({ role: "scout", attempt: 0 }),
        ),
      }),
    ).toEqual({
      model: "openai/gpt-5.6-luna",
      modelOptions: {
        providerOptions: {
          gateway: { caching: "auto" },
        },
      },
    });
  });

  test("fails closed for missing or invented lane routes", () => {
    expect(() =>
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "subagent",
        messages: childMessage("review this"),
      }),
    ).toThrow("missing");
    expect(() =>
      selectRoutedModel({
        attributes: { [routingAttribute]: config },
        channelKind: "subagent",
        messages: childMessage(
          '<known-good-review-routing>{"role":"lane","axis":"correctness"}</known-good-review-routing>',
        ),
      }),
    ).toThrow("Unknown review axis");
  });
});


test("instrumentation observes installed Eve inputs without an authored context or state mocks", () => {
  const event = {
    session: { auth: { current: { attributes: { [routingAttribute]: config } } } },
    channel: { kind: "subagent" },
    modelInput: { messages: childMessage(routingEnvelope({ role: "lane", axis: "deduplication", attempt: 0 })) },
  } as unknown as InstrumentationStepStartedEventInput;
  expect(() => reviewRouteState.get()).toThrow("No active eve context.");
  expect(instrumentation.runtimeContext?.(event)).toMatchObject({
    "review.task": "analysis", "review.requested_model": "moonshotai/kimi-k3",
  });
  expect(() => reviewRouteState.get()).toThrow("No active eve context.");
  const root = { ...event, channel: { kind: "github" }, modelInput: { messages: [] } } as unknown as InstrumentationStepStartedEventInput;
  expect(instrumentation.runtimeContext?.(root)).toEqual({ "review.role": "coordinator", "review.task": "unknown" });
  expect(readReviewRoute("subagent", [])).toBeNull();
});
