import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { parseReviewConfig } from "../src/config/review-config";
import { reviewConfigFromAuth } from "../src/config/trusted-review-config";
import { withTrustedReviewContext } from "../src/github/trusted-context";
import { chainForRoute } from "../src/models/routing";
import { selectReviewAxes } from "../src/review/axis-selection";
import { reviewAxes, reviewAxisSchema, type ReviewAxis } from "../src/review/axes";
import { projectLaneRegistryDigest } from "../src/review/project-lane-identity";
import { laneCheckName } from "../src/review/project-lanes";
import { laneReceiptSchema, orchestrateReview } from "../src/review/orchestration";
import { laneCompletedReportSchema, laneCheckpointPath, readLaneCheckpoint, writeLaneCheckpoint } from "../src/review/lane-checkpoint";
import { attestCheckpoint, verifyCheckpointAttestation } from "../src/review/checkpoint-attestation";
import { beginReviewRecovery, validateReviewRecoveryIdentity } from "../src/review/recovery";
import { assembleCanonicalReviewReport, beginReportAssembly } from "../src/review/report-assembly";
import { checkpointContent, identity } from "./fixtures/eve-runtime-smoke/agent/lib/orchestration";

const lane = { id: "project-api", name: "API compatibility", criteria: "Preserve the documented response envelope.", applicability: { paths: ["src/api"] }, referencePaths: ["docs/api.md"] };
const source = JSON.stringify({ lanes: [lane] });
const config = parseReviewConfig(source);
const digest = projectLaneRegistryDigest(config);

describe("runtime project lanes", () => {
  test("accepts only declarative, unique, bounded definitions and safe repository references", () => {
    expect(config.lanes?.[0]).toMatchObject(lane);
    for (const invalid of [
      { ...lane, id: "engineering-quality" }, { ...lane, id: "project-../outside" },
      { ...lane, id: `project-${"a".repeat(60)}` }, { ...lane, id: "project-sneak--in" },
      { ...lane, criteria: " " }, { ...lane, tools: ["shell"] }, { ...lane, credentials: ["github"] },
      { ...lane, referencePaths: ["../head-policy.md"] }, { ...lane, referencePaths: ["docs?ref=head"] },
      { ...lane, applicability: undefined },
    ]) expect(() => parseReviewConfig(JSON.stringify({ lanes: [invalid] }))).toThrow();
    for (const duplicate of [[lane, lane], [lane, { ...lane, id: "project-other", name: "api compatibility" }]]) {
      expect(() => parseReviewConfig(JSON.stringify({ lanes: duplicate }))).toThrow();
    }
    expect(() => parseReviewConfig(JSON.stringify({ lanes: Array.from({ length: 25 }, (_, index) => ({ ...lane, id: `project-lane${index}`, name: `Lane ${index}` })) }))).toThrow();
  });

  test("selects changed and renamed matching paths, preserves built-ins, and honors explicit always", () => {
    const files = [{ path: "src/api/user.ts", status: "modified" as const, blobSha: "a", patch: "@@ -1 +1 @@\n-old\n+new" }];
    const decisions = selectReviewAxes(files, [], config.lanes);
    expect(decisions.slice(0, 7).map((item) => item.axis)).toEqual([...reviewAxes]);
    expect(decisions.at(-1)).toMatchObject({ axis: "project-api", selected: true, paths: [files[0]!.path] });
    expect(selectReviewAxes([{ ...files[0]!, path: "src/apiculture/user.ts" }], [], config.lanes).at(-1)?.selected).toBe(false);
    expect(selectReviewAxes([{ ...files[0]!, path: "src/new.ts", previousPath: "src/api/old.ts" }], [], config.lanes).at(-1)?.selected).toBe(true);
    const always = parseReviewConfig(JSON.stringify({ lanes: [{ ...lane, always: true, applicability: undefined }] }));
    expect(selectReviewAxes([], [], always.lanes).at(-1)?.selected).toBe(true);
    const missingLock = selectReviewAxes([{ path: "bun.lock", blobSha: "a", status: "modified", patch: null }], []);
    expect(missingLock.filter((item) => item.selected).map((item) => item.axis)).toContain("test-health");
  });

  test("routes only configured project IDs and gives them stable named Checks", () => {
    expect(chainForRoute(config, { role: "lane", axis: "project-api", attempt: 0 })).toEqual(config.model);
    expect(() => chainForRoute(config, { role: "lane", axis: "project-forged", attempt: 0 })).toThrow("Unconfigured");
    const overridden = parseReviewConfig(JSON.stringify({ lanes: [lane], agents: { "project-api": "openai/gpt-5.6-luna" } }));
    expect(chainForRoute(overridden, { role: "lane", axis: "project-api", attempt: 0 })).toEqual(["openai/gpt-5.6-luna"]);
    expect(laneCheckName("engineering-quality", config)).toBe("slop-sheriff / engineering-quality");
    expect(laneCheckName("project-api", config)).toBe("slop-sheriff / API compatibility (project-api)");
  });

  test("generated provider-visible lane schemas admit bounded project IDs without adding application fields", async () => {
    for (const schema of [laneReceiptSchema, laneCompletedReportSchema]) {
      const generated = await asSchema<unknown>(schema).jsonSchema;
      expect(generated.additionalProperties).toBe(false);
      const axis = generated.properties?.axis;
      expect(axis).toMatchObject({ anyOf: [{ type: "string", enum: [...reviewAxes] }, { type: "string" }] });
      const pattern = (axis as { anyOf: { pattern?: string }[] }).anyOf[1]?.pattern;
      expect(pattern).toBeDefined();
      expect(new RegExp(pattern!).test("project-api")).toBe(true);
      expect(new RegExp(pattern!).test("project-../../pwn")).toBe(false);
      expect(new RegExp(pattern!).test(`project-${"a".repeat(100)}`)).toBe(false);
    }
    expect(reviewAxisSchema.safeParse("project-../../pwn").success).toBe(false);
    expect(() => laneCheckpointPath(identity.patchFingerprint, "project-../pwn")).toThrow();
  });

  test("binds signed custom checkpoints and recovery to definitions and exact base", async () => {
    const files = new Map<string, string>();
    const sandbox = { async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; }, async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content); } };
    const bound = { ...identity, laneRegistryDigest: digest };
    const checkpoint = await writeLaneCheckpoint(sandbox, bound, "project-api", checkpointContent("project-api"), 0);
    expect(await readLaneCheckpoint(sandbox, bound, "project-api")).toEqual(checkpoint);
    const other = projectLaneRegistryDigest(parseReviewConfig(JSON.stringify({ lanes: [{ ...lane, criteria: "Changed obligations." }] })));
    await expect(readLaneCheckpoint(sandbox, { ...bound, laneRegistryDigest: other }, "project-api")).rejects.toThrow("trusted review");
    const token = attestCheckpoint({ checkpoint, rootSessionId: "root", invocationId: "call", attempt: 0, operation: "write", secret: "1".repeat(64) });
    const expected = { ...bound, rootSessionId: "root", invocationId: "call", axis: "project-api" as const, attempt: 0 };
    expect(verifyCheckpointAttestation(token, expected, "1".repeat(64)).laneRegistryDigest).toBe(digest);
    expect(() => verifyCheckpointAttestation(token, { ...expected, laneRegistryDigest: other }, "1".repeat(64))).toThrow("mismatch");
    const recovery = beginReviewRecovery({ identity: { ...bound, planKind: "full" }, activeAxes: ["project-api"], selectedFindingIds: [] });
    expect(() => validateReviewRecoveryIdentity(recovery, { ...bound, laneRegistryDigest: other, planKind: "full" })).toThrow("trusted review");
  });

  test("admits more than sixteen lanes without dropping any and fails an unconfigured lane", async () => {
    const wide = parseReviewConfig(JSON.stringify({ lanes: Array.from({ length: 18 }, (_, index) => ({ ...lane, id: `project-lane${index}`, name: `Lane ${index}`, always: true })) }));
    const axes = wide.lanes!.map((item) => item.id);
    const observed: string[] = [];
    const plan = { ...identity, rootSessionId: "root", commonPrefix: "Trusted fixture", activeAxes: axes, lanes: wide.lanes ?? [], laneRegistryDigest: projectLaneRegistryDigest(wide) };
    const call = async ({ message }: { message: string }) => { observed.push(message); return {}; };
    const verifyLane = async (_raw: unknown, axis: ReviewAxis, attempt: number) => ({ receipt: { axis, status: "complete" as const, scoutRequests: [], checkpoint: "fixture" }, attestation: { version: 1 as const, rootSessionId: "root", invocationId: "fixture", axis, attempt, operation: "read" as const, ...identity, revision: 1, status: "complete" as const, checkpointDigest: "f".repeat(64) } });
    expect(await orchestrateReview({ plan, invocationPrefix: "run", call, verifyLane })).toMatchObject({ activeAxes: axes });
    expect(observed).toHaveLength(18);
    expect(observed.every((message) => message.includes(lane.criteria))).toBe(true);
    await expect(orchestrateReview({ plan: { ...plan, activeAxes: ["project-forged"] }, invocationPrefix: "run", call, verifyLane })).rejects.toThrow("trusted axes");
  });

  test("canonical assembly preserves selected project lanes and configured skipped lanes", () => {
    const decisions = selectReviewAxes([], [], config.lanes);
    const state = beginReportAssembly({ executionRevision: "review-report-v2", repositoryId: "R_repo", pullRequest: 1, ...identity, laneRegistryDigest: digest, planKind: "full", baselineHead: null, reviewPaths: [], activeAxes: ["engineering-quality"], axisDecisions: decisions, selectedFindingIds: [] });
    const report = assembleCanonicalReviewReport({ state, priorReport: null, generatedAt: "2026-09-12T00:00:00.000Z", draft: { actionSummary: "No actionable findings.", additionalConcerns: [], scope: { claim: "Fixture", dirtyState: "clean" }, coverage: { staticOnly: [], unreached: [] }, churn: { window: "Fixture", symbolCoverage: [], fileFallbacks: [] }, probes: [], freshFindings: [], verifiedClaims: [], limitations: [] } }).report;
    expect(report?.coverage.skippedAxes).toContainEqual({ name: "project-api", reason: "No changed files match trusted project lane applicability." });
    expect(report?.actionSummary).toBe("No actionable findings.");
  });

  test("voice and requirement config remain base-owned and boolean compatibility wins", () => {
    expect(parseReviewConfig("personality: false\nvoice: theatrical").voice).toBe("off");
    expect(parseReviewConfig("voice: understated").personality).toBe(true);
    expect(() => parseReviewConfig("voiceGuideContent: forged instructions")).toThrow();
    const auth = withTrustedReviewContext({ authenticator: "github", principalId: "app", principalType: "app", attributes: {} }, { ...identity, configSource: "voiceGuide: docs/voice.md\nrequirementPaths: [contracts]", voiceGuideContent: "Use precise, understated language.", event: "pull_request", plan: "{}", repositoryCreatedAt: 1, repositoryDatabaseId: 1, repositoryId: "R_repo", reviewFiles: [] });
    expect(reviewConfigFromAuth(auth)).toMatchObject({ voiceGuideContent: "Use precise, understated language.", requirementPaths: ["contracts"] });
  });
});
