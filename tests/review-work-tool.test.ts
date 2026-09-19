import { expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import schema from "../convex/schema";
import { internal } from "../convex/_generated/api";
import { ContextContainer, contextStorage } from "./fixtures/eve-context";
import { completeReviewWorkInput } from "./fixtures/review-work-contract";
import { reviewTool as workTool } from "../agent/tools/review_work";
import { reviewTool as sourceTool } from "../agent/tools/inspect_review_source";
import { reviewRouteState } from "../agent/lib/review-route";
import { getReviewEvidenceSandbox } from "../agent/lib/evidence-sandbox";
import { currentReviewEvidenceIdentity } from "../agent/lib/review-evidence";
import { withTrustedReviewContext, trustedGitHubContext } from "../src/github/trusted-context";
import { prepareReviewWork, reviewWorkProofSchema, reviewWorkPlanFromPrepared } from "../src/review/prepare-review-work";
import { runCapabilityPreflight } from "../src/review/capability-preflight";
import { reviewEvidenceManifestSchema, writeIncludedReviewEvidence } from "../src/review/evidence-bundle";
import { workHash } from "../src/review/work-plan";
import { reviewWorkResultArtifactSchema } from "../src/review/work-runtime";
import { aggregateCompletedWorkResults } from "../src/review/work-results";

const modules = {
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/reviewLifecycle.ts": () => import("../convex/reviewLifecycle"),
  "../convex/reviewWorkData.ts": () => import("../convex/reviewWorkData"),
  "../convex/artifactData.ts": () => import("../convex/artifactData"),
  "../convex/probeData.ts": () => import("../convex/probeData"),
  "../convex/http.ts": () => import("../convex/http"),
};

type ToolContext = Parameters<NonNullable<typeof workTool.execute>>[1];

/** Real Git, application preparation/tools/signing, and actual Convex HTTP handlers.
 * Only the VM filesystem/transport and already-observed native handle are fixtures. */
async function withProductionWork(run: (fixture: Awaited<ReturnType<typeof prepare>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sheriff-completion-"));
  const overrides = { CONVEX_MEMORY_URL: "https://storage.fixture.invalid", KNOWN_GOOD_REVIEW_MEMORY_TOKEN: "offline-token",
    KNOWN_GOOD_REVIEW_EVIDENCE_KEY: "ab".repeat(32), VERCEL_PROJECT_PRODUCTION_URL: "native.fixture.invalid" };
  const old = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  const t = convexTest(schema, modules);
  let nativeHandle: { rootSessionId: string; invocationId: string; sessionId: string; agentId: string } | null = null;
  let dropResultResponse = false;
  let delayedPath: string | null = null;
  let delayedRequest: (() => Promise<Response>) | null = null;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    if (url.origin === "https://native.fixture.invalid" && url.pathname === "/eve/v1/review-lifecycle") {
      expect(new Headers(init?.headers).get("x-review-operation")).toBe("work-handles");
      return Response.json({ handles: nativeHandle ? [nativeHandle] : [] });
    }
    if (url.origin !== "https://storage.fixture.invalid") throw new Error(`Offline test forbids network: ${url.origin}`);
    if (delayedPath === url.pathname && (url.pathname === "/review-work/put" || JSON.parse(String(init?.body)).path.endsWith("/result.json"))) {
      delayedPath = null;
      delayedRequest = () => t.fetch(url.pathname, init);
      throw new Error("Write timed out before the database commit");
    }
    const response = await t.fetch(url.pathname, init);
    if (dropResultResponse && url.pathname === "/review-artifacts/put" && JSON.parse(String(init?.body)).path.endsWith("/result.json")) {
      dropResultResponse = false;
      throw new Error("Completion receipt response lost after commit");
    }
    return response;
  }, { preconnect: () => {} }));

  async function prepare() {
    const files = new Map<string, string>();
    const raw = {
      async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; },
      async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content); },
      async run({ command }: { command: string }) {
        const child = Bun.spawn(["bash", "-c", command.replaceAll("/workspace", root)], { cwd: root, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        return { stdout, stderr, exitCode };
      },
    };
    async function git(...args: string[]) {
      const child = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code) throw new Error(stderr);
      return stdout.trim();
    }
    await git("init", "--quiet");
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.test");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/index.ts"), "export function accept(value: string) { return value.trim(); }\n");
    await git("add", "."); await git("commit", "--quiet", "-m", "base");
    const baseSha = await git("rev-parse", "HEAD");
    await writeFile(join(root, "src/index.ts"), "export function accept(value: string) { return value; }\n");
    await git("add", "."); await git("commit", "--quiet", "-m", "head");
    const headSha = await git("rev-parse", "HEAD"), patchFingerprint = workHash([baseSha, headSha]);
    const admission = { deliveryId: "offline-webhook", repository: "fixture/completion", repositoryId: "R_completion", pullRequest: 43,
      headSha, eventTime: 1000, body: "{}", event: "pull_request", signature: "offline" };
    await t.mutation(internal.reviewLifecycle.admit, admission);
    const [job] = await t.mutation(internal.reviewLifecycle.claim, { capacity: 1 });
    await t.mutation(internal.reviewLifecycle.activate, { attemptId: job!.attemptId, headSha, sessionId: "root" });
    const auth = withTrustedReviewContext({ authenticator: "github", principalId: "review", principalType: "app",
      attributes: { repository: admission.repository, installation_id: "1", pull_request_number: "43", delivery_id: job!.attemptId } },
    { baseSha, headSha, patchFingerprint, configSource: "", event: "pull_request", plan: JSON.stringify({ kind: "full" }),
      repositoryCreatedAt: 0, repositoryDatabaseId: 1, repositoryId: admission.repositoryId, reviewFiles: [{ path: "src/index.ts", status: "modified" }] });
    const parent = { rootSessionId: "root", callId: "pending" };
    const ctx = { session: { id: "child", parent, auth: { current: auth }, turn: { id: "turn" } },
      getSandbox: async () => raw, abortSignal: AbortSignal.timeout(10_000) } as unknown as ToolContext;
    const sandbox = await getReviewEvidenceSandbox(ctx);
    const entry = await writeIncludedReviewEvidence(sandbox, { patchFingerprint, path: "src/index.ts", status: "modified", patchTokens: 1,
      patch: await git("diff", "--full-index", baseSha, headSha, "--", "src/index.ts") });
    const manifest = reviewEvidenceManifestSchema.parse({ schemaVersion: 1, baseSha, headSha, patchFingerprint, entries: [entry] });
    const plan = await prepareReviewWork(sandbox, trustedGitHubContext(auth), { manifest, requirements: [], config: { lanes: [] }, claim: "Reject invalid input",
      decisions: [{ axis: "engineering-quality", selected: true, reason: "Changed public function", paths: ["src/index.ts"] }] });
    expect(plan.units).toHaveLength(1);
    const unit = plan.units[0]!;
    await runCapabilityPreflight(sandbox, currentReviewEvidenceIdentity(auth));
    parent.callId = `review:work:${unit.id}:0`;
    nativeHandle = { rootSessionId: parent.rootSessionId, invocationId: parent.callId, sessionId: ctx.session.id, agentId: "agent" };
    reviewRouteState.update(() => ({ role: "lane", axis: unit.axis, attempt: 0, workId: unit.id }));
    const read = await workTool.execute!({ action: { operation: "read" } }, ctx);
    expect(read).toMatchObject({ operation: "read", context: { workId: unit.id, entries: [{ path: "src/index.ts" }] } });
    const source = await sourceTool.execute!({ target: { operation: "read", path: "src/index.ts" }, revision: "head", cursor: null }, ctx);
    expect(source).toMatchObject({ content: expect.stringContaining("return value;") });
    return { t, ctx, sandbox, unit, plan, manifest, files, admission,
      complete: (input = completeReviewWorkInput()) => workTool.execute!(input, ctx),
      loseResultResponse: () => { dropResultResponse = true; },
      delayWrite: (path: string) => { delayedPath = path; },
      finishDelayedWrite: async () => { if (!delayedRequest) throw new Error("No delayed request"); return delayedRequest(); },
      readResult: async () => reviewWorkResultArtifactSchema.parse(JSON.parse((await sandbox.readTextFile({ path: unit.resultPath }))!)),
    };
  }
  try { await contextStorage.run(new ContextContainer(), async () => run(await prepare())); }
  finally {
    fetchSpy.mockRestore();
    for (const [name, value] of Object.entries(old)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(root, { recursive: true, force: true });
  }
}

test("the production completion tool authenticates, persists and assembles an actual inspected work unit", () => withProductionWork(async f => {
  expect(await f.complete()).toMatchObject({ operation: "write", receipt: { workId: f.unit.id, status: "complete" } });
  const result = await f.readResult();
  expect(result.invocation).toEqual({ rootSessionId: "root", invocationId: f.ctx.session.parent!.callId, sessionId: "child", turnId: "turn" });
  expect(reviewWorkProofSchema.parse(result.assessment.proof).sources).toHaveLength(1);
  const reports = await aggregateCompletedWorkResults({ plan: reviewWorkPlanFromPrepared(f.plan), manifest: f.manifest, results: [result.assessment], obligations: [],
    expectedInputDigest: () => f.unit.inputDigest, validateProof: async assessment => JSON.stringify(assessment) === JSON.stringify(result.assessment) });
  expect(reports.find(report => report.axis === "engineering-quality")?.candidates[0]?.title).toBe("Reject invalid input");
  f.files.clear(); // VM artifact loss must not discard the durable completion.
  expect((await f.readResult()).assessment).toEqual(result.assessment);
  await f.complete();
  expect(await f.t.run(ctx => ctx.db.query("completedReviewWork").collect())).toHaveLength(1);
}), 20_000);

test("corrected coverage can complete after the production tool rejects an incomplete report", () => withProductionWork(async f => {
  const invalid = completeReviewWorkInput();
  if (invalid.action.operation !== "complete") throw new Error("Expected completion fixture");
  invalid.action.reviewedEntries = [];
  await expect(f.complete(invalid)).rejects.toThrow("exact review scope");
  expect(await f.t.run(ctx => ctx.db.query("completedReviewWork").collect())).toHaveLength(0);
  expect((await f.t.query(internal.reviewLifecycle.inspect, { attemptId: f.ctx.session.auth.current!.attributes.delivery_id as string, includeSuperseded: false }))?.status).toBe("running");
  const claims = await f.t.run(ctx => ctx.db.query("reviewProbeClaims").collect());
  expect(claims.filter(claim => claim.status === "interrupted")).toHaveLength(0);
  expect(await f.complete()).toMatchObject({ receipt: { status: "complete" } });
}), 20_000);

test("a lost completion response retries the production tool without replacing findings or repeating analysis", () => withProductionWork(async f => {
  f.loseResultResponse();
  await expect(f.complete()).rejects.toThrow("response lost after commit");
  expect((await f.readResult()).assessment.checkpoint.status).toBe("complete");
  expect(await f.complete()).toMatchObject({ receipt: { status: "complete" } });
  expect(await f.t.run(ctx => ctx.db.query("completedReviewWork").collect())).toHaveLength(1);
}), 20_000);

test.each(["/review-artifacts/put", "/review-work/put"])("a delayed %s from a failed progress write cannot replace the completed retry", path => withProductionWork(async f => {
  f.delayWrite(path);
  await expect(f.complete({ action: { operation: "progress", reviewedEntries: [], remainingEntries: [0], observations: [],
    nextSteps: ["Finish source assessment"], limitations: [], escalation: null } })).rejects.toThrow("before the database commit");
  await f.complete();
  const before = await f.readResult();
  if (path === "/review-artifacts/put") await expect(f.finishDelayedWrite()).rejects.toThrow("write lock no longer owns");
  else expect((await f.finishDelayedWrite()).status).toBe(403);
  expect(await f.readResult()).toEqual(before);
  const saved = await f.t.run(ctx => ctx.db.query("completedReviewWork").order("desc").first());
  const content = await f.t.run(async ctx => (await ctx.storage.get(saved!.storageId))!.text());
  expect(JSON.parse(content).checkpoint.status).toBe("complete");
}), 20_000);

test("a newer admitted head prevents the actual completion tool from writing stale evidence", () => withProductionWork(async f => {
  await f.t.mutation(internal.reviewLifecycle.admit, { ...f.admission, deliveryId: "new-push", headSha: "f".repeat(40), eventTime: 2000 });
  await expect(f.complete()).rejects.toThrow("no longer owns this review");
  expect(await f.t.run(ctx => ctx.db.query("completedReviewWork").collect())).toHaveLength(0);
}), 20_000);
