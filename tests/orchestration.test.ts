import { expect, test } from "bun:test";
import { orchestrateReview, type ReviewChildDispatch } from "../src/review/orchestration";
import { verifyReviewWorkReceipt, reviewWorkNativeHandlePath } from "../agent/lib/review-workflow";
import { checkpointContent } from "./fixtures/eve-runtime-smoke/agent/lib/orchestration";
import { workOrchestrationFixture } from "./work-orchestration-fixture";
import { parseSubagentRoute } from "../src/models/routing";
import { workHash } from "../src/review/work-plan";

function fixture(continuations = 0) {
  const value = workOrchestrationFixture();
  const calls: ReviewChildDispatch[] = [];
  let cancelled = 0;
  const run = () => orchestrateReview({ plan: value.plan, invocationPrefix: "run", reuseWork: async () => null,
    cancelOutstanding: async () => { cancelled++; },
    call: async dispatch => {
      calls.push(dispatch);
      const route = parseSubagentRoute([{ role: "user", content: dispatch.message }]);
      if (route.role !== "lane" || !route.workId) throw new Error("Missing work route");
      const assessment = structuredClone(value.assessments.get(route.workId)!);
      const count = Number(dispatch.key.split(":").at(-1));
      const incomplete = route.axis === "engineering-quality" && count < continuations;
      assessment.checkpoint = checkpointContent(route.axis, incomplete);
      if (incomplete) assessment.checkpoint.observations = [{ disposition: "lead", summary: `Evidence ${count}`, evidence: ["observed source"] }];
      const unit = value.plan.prepared.units.find(unit => unit.id === route.workId)!;
      const invocation = { rootSessionId: "root", invocationId: `tool:${dispatch.key}`, sessionId: `native-${unit.id}`, turnId: `turn-${count}` };
      await value.reader.writeTextFile({ path: unit.resultPath, content: JSON.stringify({ schemaVersion:2, attemptId:value.plan.attemptId, assessment, invocation }) });
      await value.reader.writeTextFile({ path: reviewWorkNativeHandlePath(value.plan.prepared.patchFingerprint, invocation.invocationId), content: JSON.stringify({ rootSessionId: invocation.rootSessionId, invocationId: invocation.invocationId, sessionId: invocation.sessionId, agentId: `agent-${unit.id}` }) });
      return { workId: unit.id, status: assessment.checkpoint.status };
    },
    verifyWork: (raw, unit, key, previousSessionId) => verifyReviewWorkReceipt({ raw, unit, invocationId: `tool:${key}`, plan: value.plan, reader: value.reader, ...(previousSessionId ? { previousSessionId } : {}) }),
  });
  return { ...value, calls, run, cancellations: () => cancelled };
}

test("prepared work uses one native child per unit and retains context beyond arbitrary step counts", async () => {
  const f = fixture(20);
  const outcome = await f.run();
  expect(outcome.complete).toBe(true);
  expect(f.calls).toHaveLength(22);
  const core = f.calls.filter(call => call.message.includes('"axis":"engineering-quality"'));
  expect(core[0]!.agentId).toBeUndefined();
  expect(core.slice(1).every(call => call.agentId === core[1]!.agentId && call.agentId)).toBe(true);
  expect(core.every(call => call.message.includes('"attempt":0'))).toBe(true);
  expect(f.cancellations()).toBe(0);
});

test("verified prepared completion skips model dispatch without inventing a new invocation", async () => {
  const f = fixture();
  let called = 0;
  const result = await orchestrateReview({ plan: f.plan, invocationPrefix: "next", call: async () => { called++; throw new Error("should reuse"); }, reuseWork: async unit => f.assessments.get(unit.id)!, verifyWork: async () => { throw new Error("no current invocation on reuse"); }, cancelOutstanding: async () => {} });
  expect(called).toBe(0); expect(result.assessments).toHaveLength(2);
});

test("model receipt cannot substitute another signed invocation or child session", async () => {
  const f = fixture(); await f.run(); const unit = f.plan.prepared.units[0]!;
  await expect(verifyReviewWorkReceipt({ raw: { workId: unit.id, status: "complete" }, unit, invocationId: "forged", plan: f.plan, reader: f.reader })).rejects.toThrow("artifact is missing");
  const key = `tool:run:work:${unit.id}:0`;
  await expect(verifyReviewWorkReceipt({ raw: { workId: unit.id, status: "complete" }, unit, invocationId: key, plan: {...f.plan,attemptId:"new-attempt"}, reader: f.reader })).rejects.toThrow("another admitted attempt");
  await expect(verifyReviewWorkReceipt({ raw: { workId: unit.id, status: "complete" }, unit, invocationId: key, plan: f.plan, reader: f.reader, previousSessionId: "different-prior-child" })).rejects.toThrow("exact native invocation");
  const raw = JSON.parse(f.files.get(unit.resultPath)!); raw.invocation.invocationId = "other-call"; f.files.set(unit.resultPath, JSON.stringify(raw));
  await expect(verifyReviewWorkReceipt({ raw: { workId: unit.id, status: "complete" }, unit, invocationId: key, plan: f.plan, reader: f.reader })).rejects.toThrow("exact native invocation");
});

test("sibling failure cancels outstanding native work and does not wait forever on its lost callback", async () => {
  const f = fixture(); let cancellations = 0;
  const result = orchestrateReview({ plan: f.plan, invocationPrefix: "failure", reuseWork: async () => null,
    call: async dispatch => { if (dispatch.message.includes('"axis":"engineering-quality"')) throw new Error("provider failure"); return new Promise<never>(() => {}); },
    verifyWork: async () => { throw new Error("unreachable"); }, cancelOutstanding: async () => { cancellations++; },
  });
  await expect(result).rejects.toThrow("provider failure"); expect(cancellations).toBe(1);
});

test("repeated semantic progress fails visibly before another paid dispatch", async () => {
  const f = fixture(); const unit = f.plan.prepared.units[0]!; const assessment = structuredClone(f.assessments.get(unit.id)!); assessment.checkpoint = checkpointContent(unit.axis, true);
  let calls = 0, cancellations = 0;
  await expect(orchestrateReview({ plan: { ...f.plan, prepared: { ...f.plan.prepared, units: [unit] } }, invocationPrefix: "repeat", reuseWork: async () => null, call: async () => { calls++; return {}; },
    verifyWork: async () => ({ assessment, sessionId: "native", agentId: "agent", turnId: `turn-${calls}`, progressDigest: workHash(assessment.checkpoint) }), cancelOutstanding: async () => { cancellations++; },
  })).rejects.toThrow("without progress");
  expect(calls).toBe(2); expect(cancellations).toBe(1);
});

test("explicit verified escalation opens a stronger native context with compact evidence", async () => {
  const { parseReviewConfig } = await import("../src/config/review-config");
  const f = fixture(); const unit = f.plan.prepared.units[0]!;
  const assessment = structuredClone(f.assessments.get(unit.id)!);
  assessment.checkpoint = checkpointContent(unit.axis, true);
  const calls: ReviewChildDispatch[] = [];
  const previous: (string | undefined)[] = [];
  await orchestrateReview({ plan: { ...f.plan, modelConfig: parseReviewConfig(null), prepared: { ...f.plan.prepared, units: [unit] } }, invocationPrefix: "escalate", reuseWork: async () => null,
    call: async dispatch => { calls.push(dispatch); return {}; },
    verifyWork: async (_raw,_unit,_key,prior) => { previous.push(prior); return { assessment: calls.length === 1 ? assessment : f.assessments.get(unit.id)!, sessionId: `child-${calls.length}`, agentId: `agent-${calls.length}`, turnId: "turn_0", progressDigest: "verified-observation", escalation: calls.length === 1 ? { difficulty: "ambiguous", reason: "Two interpretations conflict", evidence: ["Observed contract and implementation differ"] } : null }; }, cancelOutstanding: async () => {},
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]!.agentId).toBeUndefined();
  expect(previous).toEqual([undefined, undefined]);
  expect(parseSubagentRoute([{ role: "user", content: calls[1]!.message }])).toMatchObject({ difficulty: "ambiguous", workId: unit.id, attempt: 0 });
  expect(calls[1]!.message).toContain("Observed contract and implementation differ");
});

test("an unchanged model and effort cannot cause an identical fresh escalation", async () => {
  const { parseReviewConfig } = await import("../src/config/review-config");
  const f = fixture(); const unit = f.plan.prepared.units[0]!; const assessment = structuredClone(f.assessments.get(unit.id)!); assessment.checkpoint = checkpointContent(unit.axis, true);
  let calls = 0;
  const config = parseReviewConfig("tasks:\n  analysis:\n    model: openai/gpt-5.6-sol\n    reasoning: high\n    escalationModel: openai/gpt-5.6-sol\n    escalationReasoning: high\n");
  await expect(orchestrateReview({ plan: { ...f.plan, modelConfig: config, prepared: { ...f.plan.prepared, units: [unit] } }, invocationPrefix: "same", reuseWork: async () => null, call: async () => { calls++; return {}; }, verifyWork: async () => ({ assessment, sessionId: "child", agentId: "agent", turnId: "turn_0", progressDigest: "proof", escalation: { difficulty: "ambiguous", reason: "unclear", evidence: ["observed"] } }), cancelOutstanding: async () => {} })).rejects.toThrow("no stronger escalation");
  expect(calls).toBe(1);
});

test("rewritten plans cannot substitute for new authenticated progress", async () => {
  const { reviewWorkProgressDigest } = await import("../src/review/work-progress");
  const f = fixture(); const assessment = structuredClone(f.assessments.values().next().value!); assessment.checkpoint = checkpointContent(assessment.unit.axis, true);
  const before = reviewWorkProgressDigest(assessment);
  assessment.checkpoint.nextSteps = ["Try a differently worded plan"];
  assessment.checkpoint.limitations = ["Still investigating"];
  expect(reviewWorkProgressDigest(assessment)).toBe(before);
  assessment.checkpoint.observations = [{ disposition: "lead", summary: "Actual new observed invariant", evidence: ["checked source"] }];
  expect(reviewWorkProgressDigest(assessment)).not.toBe(before);
});

test("component expansion stays within admitted axis capacity and completes every unit", async () => {
  const f = fixture(); const source = f.plan.prepared.units[0]!;
  const units = Array.from({ length: 35 }, (_value,index) => ({ ...source, id: workHash([source.id,index]) }));
  let active = 0, maximum = 0, calls = 0;
  const completed = await orchestrateReview({ plan: { ...f.plan, activeAxes: [source.axis], prepared: { ...f.plan.prepared, units } }, invocationPrefix: "capacity", reuseWork: async () => null,
    call: async () => { active++; maximum = Math.max(maximum,active); calls++; await new Promise(resolve => setTimeout(resolve,1)); active--; return {}; },
    verifyWork: async (_raw,unit) => ({ assessment: { ...f.assessments.get(source.id)!, unit }, sessionId: `child-${unit.id}`, agentId: `agent-${unit.id}`, turnId: "turn_0", progressDigest: "completed" }), cancelOutstanding: async () => {},
  });
  expect(maximum).toBe(1); expect(calls).toBe(35); expect(completed.assessments).toHaveLength(35);
});

test("cancellation interrupts queued proof reads and awaits the native cancellation fence", async () => {
  const f = fixture(); const abort = new AbortController(); let cancellations = 0;
  const result = orchestrateReview({ plan: f.plan, invocationPrefix: "cancel-proof", abortSignal: abort.signal, reuseWork: async () => new Promise<never>(() => {}), call: async () => { throw new Error("cancelled proof cannot dispatch"); }, verifyWork: async () => { throw new Error("unreachable"); }, cancelOutstanding: async () => { await Promise.resolve(); cancellations++; } });
  abort.abort(new Error("parent cancelled"));
  await expect(result).rejects.toThrow("parent cancelled"); expect(cancellations).toBe(1);
});
