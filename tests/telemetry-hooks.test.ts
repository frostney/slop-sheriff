import { expect, spyOn, test } from "bun:test";
import type { HookContext, HookEvent } from "eve/hooks";
import { ContextContainer, contextStorage, serializeContext, deserializeContext } from "./fixtures/eve-context";
import usageCapture from "./fixtures/pr65-telemetry-usage.json";
import telemetry from "../agent/hooks/telemetry";

test("terminal session failure stops the root VM even when no turn failure event arrives", async () => {
  let stops = 0;
  for (const kind of ["github", "subagent"]) {
    const ctx = {
      channel: { kind }, session: { id: `fatal-${kind}`, ...(kind === "subagent" ? { parent: {} } : {}), auth: { current: null } },
      getSandbox: async () => ({ stop: async () => { stops += 1; } }),
    } as unknown as HookContext;
    const event = { type: "session.failed", meta: { id: `fatal-${kind}`, at: "2026-09-13T17:02:00Z" }, data: {
        sessionId: ctx.session.id, code: "FatalError",
        message: 'Step "step//eve@0.52.5//turnStep" failed after 3 retries: Review attempt has been superseded or is no longer admitted',
    } } as HookEvent<"session.failed">;
    const first = new ContextContainer();
    await contextStorage.run(first, async () => {
      await telemetry.events?.["session.failed"]?.(event, ctx);
    });
    const restored = await deserializeContext(serializeContext(first));
    await contextStorage.run(restored, async () => {
      await telemetry.events?.["session.failed"]?.(event, ctx);
      if (kind === "github") {
        expect(stops).toBe(1);
        await telemetry.events?.["turn.started"]?.({ type: "turn.started", meta: { id: "new-turn" }, data: { turnId: "turn_1", sequence: 1 } } as HookEvent<"turn.started">, ctx);
        await telemetry.events?.["session.failed"]?.(event, ctx);
      }
    });
  }
  expect(stops).toBe(2);
});

test("flushes cancelled-turn usage once and stops only the root sandbox", async () => {
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation((value) => { logged.push(JSON.parse(String(value))); });
  let stops = 0;
  try {
    for (const kind of ["github", "subagent"]) {
      const ctx = {
        channel: { kind }, session: { id: `cancel-${kind}`, auth: { current: null } },
        getSandbox: async () => ({ stop: async () => { stops += 1; } }),
      } as unknown as HookContext;
      const context = new ContextContainer();
      await contextStorage.run(context, async () => {
      telemetry.events?.["step.completed"]?.({
        type: "step.completed", meta: { id: `event-${kind}` },
        data: { turnId: "turn", stepIndex: 0, usage: { inputTokens: 120, outputTokens: 8 } },
      } as HookEvent<"step.completed">, ctx);
      const event: HookEvent<"turn.cancelled"> = {
        type: "turn.cancelled", data: { sequence: 1, turnId: "turn" },
        meta: { id: `cancel-${kind}`, at: "2026-09-05T00:00:00.000Z" },
      };
      await telemetry.events?.["turn.cancelled"]?.(event, ctx);
      // Replayed terminal events must not emit already-flushed usage again.
      await telemetry.events?.["turn.cancelled"]?.(event, ctx);
      });
    }
    const budgets = logged.filter((record) => record.event === "known-good-review.budget.completed");
    expect(budgets).toHaveLength(2);
    expect(budgets.map(({ inputTokens, outputTokens }) => ({ inputTokens, outputTokens })))
      .toEqual([{ inputTokens: 120, outputTokens: 8 }, { inputTokens: 120, outputTokens: 8 }]);
    expect(stops).toBe(1);
  } finally { logging.mockRestore(); }
});

test("retains all PR65 model usage across fresh hook modules and native durable context restoration", async () => {
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation(value => { logged.push(JSON.parse(String(value))); });
  let serialized = {};
  const ctx = { channel: { kind: "subagent" }, session: { id: usageCapture.sessionId, parent: {}, auth: { current: null } } } as unknown as HookContext;
  let moduleIndex = 0;
  // A distinct module instance at each boundary reproduces Workflow worker turnover.
  const freshHook = async () => (await import(`../agent/hooks/telemetry.ts?usage-boundary=${moduleIndex++}`)).default as typeof telemetry;
  try {
    for (const step of usageCapture.steps) {
      const hook = await freshHook();
      const context = await deserializeContext(structuredClone(serialized));
      await contextStorage.run(context, async () => {
        const event = { type: "step.completed", meta: { id: step.generationId, at: "2026-09-08T00:00:00Z" }, data: {
          ...step, finishReason: step.finishReason === "stop" ? "stop" : "tool-calls", providerMetadata: { gateway: { generationId: step.generationId } },
        } } as HookEvent<"step.completed">;
        await hook.events?.["step.completed"]?.(event, ctx);
        // A new event envelope for the same generation is still one model call.
        await hook.events?.["step.completed"]?.({
          ...event, meta: { ...event.meta, id: `${event.meta.id}-redelivered` },
        }, ctx);
      });
      serialized = serializeContext(context);
    }
    for (let terminalDelivery = 0; terminalDelivery < 2; terminalDelivery++) {
      const hook = await freshHook();
      const context = await deserializeContext(structuredClone(serialized));
      await contextStorage.run(context, async () => {
        await hook.events?.["turn.cancelled"]?.({ type: "turn.cancelled", meta: { id: "cancel-capture", at: "2026-09-08T00:00:00Z" }, data: { turnId: "turn_0", sequence: 1 } }, ctx);
      });
      serialized = serializeContext(context);
    }
    const budgets = logged.filter(record => record.event === "known-good-review.budget.completed");
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toMatchObject({ scope: "session-turn", modelSteps: 5, inputTokens: 76832,
      outputTokens: 2574, cacheReadTokens: 56974, cacheWriteTokens: 19848 });
    expect(budgets[0]?.sdkCostUsd).toBeCloseTo(0.0743096, 10);
  } finally { logging.mockRestore(); }
});

test("reports absent SDK quantities as unknown instead of zero", async () => {
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation(value => { logged.push(JSON.parse(String(value))); });
  const ctx = { channel: { kind: "subagent" }, session: { id: "unknown-usage", parent: {}, auth: { current: null } } } as unknown as HookContext;
  try {
    await contextStorage.run(new ContextContainer(), async () => {
      telemetry.events?.["step.completed"]?.({ type: "step.completed", meta: { id: "unknown" },
        data: { turnId: "turn", stepIndex: 0, usage: { inputTokens: 12 } } } as HookEvent<"step.completed">, ctx);
      await telemetry.events?.["turn.cancelled"]?.({ type: "turn.cancelled", meta: { id: "cancel-unknown", at: "2026-09-08T00:00:00Z" }, data: { turnId: "turn", sequence: 1 } }, ctx);
    });
    expect(logged.find(record => record.event === "known-good-review.model.completed")).toMatchObject({
      inputTokens: 12, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, sdkCostUsd: null,
    });
    expect(logged.find(record => record.event === "known-good-review.budget.completed")).toMatchObject({
      inputTokens: 12, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, sdkCostUsd: null,
    });
  } finally { logging.mockRestore(); }
});


test("retains measured zero token and cost quantities in completed-model logging", async () => {
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation(value => { logged.push(JSON.parse(String(value))); });
  const ctx = { channel: { kind: "subagent" }, session: { id: "zero-usage", parent: {}, auth: { current: null } } } as unknown as HookContext;
  try {
    await contextStorage.run(new ContextContainer(), async () => {
      telemetry.events?.["step.completed"]?.({ type: "step.completed", meta: { id: "zero" },
        data: { turnId: "turn", stepIndex: 0, usage: { inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } } } as HookEvent<"step.completed">, ctx);
    });
    expect(logged.find(record => record.event === "known-good-review.model.completed")).toMatchObject({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, sdkCostUsd: 0,
    });
  } finally { logging.mockRestore(); }
});

test("successful publication survives worker turnover and cannot bless a later turn", async () => {
  const publication = await import("../src/github/publication");
  const failClosed = spyOn(publication, "publishFailClosedCheck").mockResolvedValue("offline-check");
  const errorLogs = spyOn(console, "error").mockImplementation(() => {});
  const network = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => { throw new Error("Unexpected network call"); }, { preconnect() {} }));
  const ctx = { channel: { kind: "github" }, session: { id: "published-root", auth: { current: { attributes: {
    repository: "acme/widget", installation_id: "1", pull_request_number: "7",
    known_good_review_repository_created_at: "0", known_good_review_repository_id: "R_widget",
    known_good_review_base_sha: "base", known_good_review_head_sha: "head",
    known_good_review_plan: JSON.stringify({ kind: "full" }),
  } } } }, getSandbox: async () => ({ stop: async () => {} }) } as unknown as HookContext;
  try {
    const initial = new ContextContainer();
    const initialHookPath = "../agent/hooks/telemetry.ts?publication=initial";
    const hook = (await import(initialHookPath)).default as typeof telemetry;
    await contextStorage.run(initial, async () => {
      await hook.events?.["action.result"]?.({ type: "action.result", meta: { id: "publication", at: "2026-09-08T00:00:00Z" }, data: {
        turnId: "published-turn", sequence: 1, stepIndex: 1, status: "completed",
        result: { kind: "tool-result", toolName: "publish_review", callId: "publish-call", output: { checkUrl: "https://github.com/acme/widget/pull/7/checks", findingCount: 0, memory: "unavailable" } },
      } } as HookEvent<"action.result">, ctx);
    });
    let serialized = serializeContext(initial);
    for (const [delivery, turnId] of ["published-turn", "published-turn", "later-unpublished-turn"].entries()) {
      const fresh = (await import(`../agent/hooks/telemetry.ts?publication=${turnId}-${delivery}`)).default as typeof telemetry;
      const restored = await deserializeContext(structuredClone(serialized));
      await contextStorage.run(restored, async () => {
        await fresh.events?.["turn.completed"]?.({ type: "turn.completed", meta: { id: `end-${turnId}`, at: "2026-09-08T00:00:00Z" }, data: { turnId, sequence: 2 } }, ctx);
      });
      serialized = serializeContext(restored);
      expect(failClosed).toHaveBeenCalledTimes(turnId === "published-turn" ? 0 : 1);
    }
    for (const terminal of ["turn.failed", "turn.cancelled"] as const) {
      const freshPath = `../agent/hooks/telemetry.ts?publication-cleanup=${terminal}`;
      const fresh = (await import(freshPath)).default as typeof telemetry;
      const restored = await deserializeContext(structuredClone(serializeContext(initial)));
      await contextStorage.run(restored, async () => {
        if (terminal === "turn.failed") {
          await fresh.events?.["turn.failed"]?.({ type: "turn.failed", meta: { id: terminal, at: "2026-09-08T00:00:00Z" },
            data: { turnId: "published-turn", sequence: 2, code: "OFFLINE_TEST", message: "offline fixture" } }, ctx);
        } else {
          await fresh.events?.["turn.cancelled"]?.({ type: "turn.cancelled", meta: { id: terminal, at: "2026-09-08T00:00:00Z" },
            data: { turnId: "published-turn", sequence: 2 } }, ctx);
        }
        const before = failClosed.mock.calls.length;
        await fresh.events?.["turn.completed"]?.({ type: "turn.completed", meta: { id: "after-cleanup", at: "2026-09-08T00:00:00Z" },
          data: { turnId: "published-turn", sequence: 3 } }, ctx);
        expect(failClosed).toHaveBeenCalledTimes(before + 1);
      });
    }
    expect(network).not.toHaveBeenCalled();
  } finally { failClosed.mockRestore(); errorLogs.mockRestore(); network.mockRestore(); }
});

test("retains the bound lane and requested model across step worker turnover", async () => {
  const { reviewRouteState } = await import("../agent/lib/review-route");
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation(value => { logged.push(JSON.parse(String(value))); });
  const ctx = { channel: { kind: "subagent" }, session: { id: "lane-worker", parent: {}, auth: { current: null } } } as unknown as HookContext;
  try {
    const initial = new ContextContainer();
    const startedPath = "../agent/hooks/telemetry.ts?lane-worker=started";
    const started = (await import(startedPath)).default as typeof telemetry;
    await contextStorage.run(initial, async () => {
      reviewRouteState.update(() => ({ role: "lane", axis: "engineering-quality", attempt: 2 }));
      await started.events?.["step.started"]?.({ type: "step.started", meta: { id: "step-start", at: "2026-09-08T00:00:00Z" }, data: {
        turnId: "lane-turn", stepIndex: 0, sequence: 0, modelId: "openai/gpt-5.6-sol",
      } }, ctx);
    });
    const restored = await deserializeContext(structuredClone(serializeContext(initial)));
    const completedPath = "../agent/hooks/telemetry.ts?lane-worker=completed";
    const completed = (await import(completedPath)).default as typeof telemetry;
    await contextStorage.run(restored, async () => {
      await completed.events?.["step.completed"]?.({ type: "step.completed", meta: { id: "step-end", at: "2026-09-08T00:00:00Z" }, data: {
        turnId: "lane-turn", stepIndex: 0, sequence: 0, finishReason: "stop", usage: { inputTokens: 12, outputTokens: 4 },
      } }, ctx);
    });
    expect(logged.find(record => record.event === "known-good-review.model.completed")).toMatchObject({
      requestedModel: "openai/gpt-5.6-sol", reviewAxis: "engineering-quality", phase: "fresh-axes", attempt: 2,
    });
  } finally { logging.mockRestore(); }
});


test("presentation telemetry retains the actual step route while a new root turn resets to adjudication", async () => {
  const { bindCoordinatorPresentationOnly, currentReviewRoute } = await import("../agent/lib/review-route");
  const logged: Record<string, unknown>[] = [];
  const logging = spyOn(console, "info").mockImplementation(value => { logged.push(JSON.parse(String(value))); });
  const ctx = { channel: { kind: "github" }, session: { id: "presentation-worker", auth: { current: null } } } as unknown as HookContext;
  try {
    const initial = new ContextContainer();
    await contextStorage.run(initial, async () => {
      bindCoordinatorPresentationOnly(true);
      await telemetry.events?.["step.started"]?.({ type: "step.started", meta: { id: "presentation-start", at: "2026-09-13T00:00:00Z" }, data: {
        turnId: "presentation-turn", stepIndex: 0, sequence: 0, modelId: "openai/gpt-5.6-luna",
      } }, ctx);
    });
    const restored = await deserializeContext(serializeContext(initial));
    await contextStorage.run(restored, async () => {
      await telemetry.events?.["turn.started"]?.({ type: "turn.started", meta: { id: "new-review-turn" }, data: { turnId: "new-turn", sequence: 1 } } as HookEvent<"turn.started">, ctx);
      expect(currentReviewRoute("github", []).task).toBeUndefined();
      await telemetry.events?.["step.completed"]?.({ type: "step.completed", meta: { id: "presentation-end", at: "2026-09-13T00:00:00Z" }, data: {
        turnId: "presentation-turn", stepIndex: 0, sequence: 0, finishReason: "stop", usage: { inputTokens: 12, outputTokens: 4 },
      } }, ctx);
    });
    expect(logged.find(record => record.event === "known-good-review.model.completed")).toMatchObject({
      requestedModel: "openai/gpt-5.6-luna", phase: "presentation", attempt: 0,
    });
  } finally { logging.mockRestore(); }
});
