import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authenticatedEvidenceSandbox } from "../src/review/authenticated-evidence";
import {
  preparedProbeObservation, reviewProbeCommand, reviewProbeIdentity, reviewProbeReuse,
  reviewProbeSnapshotCommandFor, runSharedReviewProbe,
  type ProbeClaims, type ProbeObservation, type ReviewProbeInput, type SharedProbeExecution,
} from "../src/review/probe-execution";

const input: ReviewProbeInput = { command: "bun run check", cwd: ".", stdin: null, environment: [], rerun: false };
const observation: ProbeObservation = { sourceDigest: "1".repeat(64), environmentDigest: "2".repeat(64), externalStateDigest: null, reuse: "same-snapshot" };
function fixture() {
  const files = new Map<string, string>();
  const claims = new Map<string, string>();
  const interrupted = new Set<string>();
  let calls = 0;
  const evidence = authenticatedEvidenceSandbox({
    async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; },
    async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content); },
  }, "root", "a".repeat(64));
  const coordinator: ProbeClaims = {
    async assertCurrent() {},
    async claim(path, owner) {
      const previous = claims.get(path);
      if (previous) return { acquired: false, owner: previous };
      claims.set(path, owner);
      return { acquired: true, owner };
    },
    async release(path, owner) { if (claims.get(path) !== owner) throw new Error("wrong owner"); claims.delete(path); },
    async fail(path) { interrupted.add(path); },
    async assertHealthy(path) { if (interrupted.has(path)) throw new Error("Probe outcome is unknown after interruption"); },
  };
  const context: SharedProbeExecution = {
    repositoryId: "R_1", origin: { attemptId: "attempt", sessionId: "lane-1", callId: "call-1" },
    evidence, claims: coordinator, observe: async () => observation,
    execute: async () => { calls += 1; return { exitCode: 0, stdout: "actual result", stderr: "" }; },
  };
  return { files, claims, context, calls: () => calls };
}
async function shell(command: string) {
  const process = Bun.spawn(["/bin/bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { exitCode, stdout, stderr };
}

test("concurrent lanes and a later lane share one real command execution and signed receipt", async () => {
  const setup = fixture();
  let executions = 0;
  const context = { ...setup.context, execute: async () => { executions += 1; return shell("sleep 0.05; printf 'tested once'; printf 'diagnostic' >&2; exit 3"); } };
  const [first, sibling] = await Promise.all([
    runSharedReviewProbe(input, context),
    runSharedReviewProbe(input, { ...context, origin: { ...context.origin, sessionId: "lane-2", callId: "call-2" } }),
  ]);
  const later = await runSharedReviewProbe(input, context);
  expect(executions).toBe(1);
  expect(first.receipt.result).toEqual({ exitCode: 3, stdout: "tested once", stderr: "diagnostic" });
  expect(sibling.receipt).toEqual(first.receipt);
  expect(later.receipt).toEqual(first.receipt);
  expect([first.reused, sibling.reused, later.reused]).toEqual([false, true, true]);
  expect(setup.files.get(first.receiptPath)).toStartWith("known-good-review-signed-v1 ");
  expect(setup.claims.size).toBe(0);
});

test("script, arguments, stdin, toolchain, source, external state and environment changes rerun", async () => {
  const setup = fixture();
  const initial = await runSharedReviewProbe(input, setup.context);
  const variants = [
    { ...input, command: "bun run check --seed=2" },
    { ...input, stdin: "second scenario" },
    { ...input, environment: [{ name: "SCENARIO", value: "2" }] },
    { ...input, cwd: "subproject" },
  ];
  for (const variant of variants) expect((await runSharedReviewProbe(variant, setup.context)).receipt.probeId).not.toBe(initial.receipt.probeId);
  for (const changed of [{ sourceDigest: "3".repeat(64) }, { environmentDigest: "4".repeat(64) }, { externalStateDigest: "5".repeat(64) }]) {
    expect((await runSharedReviewProbe(input, { ...setup.context, observe: async () => ({ ...observation, ...changed }) })).reused).toBe(false);
  }
  expect(setup.calls()).toBe(8);
  const sorted = { ...input, environment: [{ name: "B", value: "2" }, { name: "A", value: "1" }] };
  const reordered = { ...sorted, environment: [...sorted.environment].reverse() };
  expect(reviewProbeIdentity("R_1", sorted, observation)).toBe(reviewProbeIdentity("R_1", reordered, observation));
  expect(reviewProbeIdentity("R_2", input, observation)).not.toBe(initial.receipt.probeId);
});

test("explicit independent sampling and unobserved external state never share", async () => {
  const setup = fixture();
  const independent = await Promise.all([1, 2].map(() => runSharedReviewProbe({ ...input, rerun: true }, setup.context)));
  expect(new Set(independent.map(result => result.receipt.executionId)).size).toBe(2);
  const fresh = { ...setup.context, observe: async () => ({ ...observation, reuse: "fresh" as const }) };
  await Promise.all([runSharedReviewProbe(input, fresh), runSharedReviewProbe(input, fresh)]);
  await runSharedReviewProbe(input, fresh);
  expect(setup.calls()).toBe(5);
  for (const command of ["curl https://example.org", "bun test --repeat=3", "bun test --watch", "node arbitrary.js", "bun run check && date", "pytest --retries 2"]) expect(reviewProbeReuse(command)).toBe("fresh");
});

test("input changes during execution retain the result but prevent its reuse", async () => {
  const setup = fixture();
  let reads = 0;
  const result = await runSharedReviewProbe(input, { ...setup.context, observe: async () => ({ ...observation, sourceDigest: (++reads === 1 ? "1" : "3").repeat(64) }) });
  expect(result.receipt.reusable).toBe(false);
  expect(result.receipt.status).toBe("completed");
  await runSharedReviewProbe(input, setup.context);
  expect(setup.calls()).toBe(2);
});

test("transport interruption has no invented exit status and a later attempt can execute", async () => {
  const setup = fixture();
  await expect(runSharedReviewProbe(input, { ...setup.context, execute: async () => { throw new Error("worker transport lost"); } })).rejects.toThrow("interrupted");
  const receipt = [...setup.files.values()].map(value => JSON.parse(value.slice(value.indexOf("\n") + 1))).find(value => value.status === "interrupted");
  expect(receipt.result).toBeNull();
  expect(receipt.reusable).toBe(false);
  expect(setup.claims.size).toBe(0);
  expect((await runSharedReviewProbe(input, setup.context)).reused).toBe(false);
});

test("an unacknowledged receipt commit is recovered by the competing worker without rerunning", async () => {
  const setup = fixture();
  await expect(runSharedReviewProbe(input, { ...setup.context, evidence: {
    readTextFile: setup.context.evidence.readTextFile,
    async writeTextFile(options) { await setup.context.evidence.writeTextFile(options); throw new Error("acknowledgement lost"); },
  } })).rejects.toThrow("acknowledgement lost");
  expect(setup.claims.size).toBe(1);
  const recovered = await runSharedReviewProbe(input, setup.context);
  expect(recovered.reused).toBe(true);
  expect(setup.calls()).toBe(1);
});

test("missing receipts retain ownership until lifecycle fencing; waiter cancellation cannot steal it", async () => {
  const setup = fixture();
  await expect(runSharedReviewProbe(input, { ...setup.context, evidence: {
    readTextFile: setup.context.evidence.readTextFile,
    async writeTextFile() { throw new Error("storage unavailable"); },
  } })).rejects.toThrow("storage unavailable");
  const cancel = new AbortController();
  const waiting = runSharedReviewProbe(input, { ...setup.context, signal: cancel.signal });
  cancel.abort(new Error("prior worker fenced"));
  await expect(waiting).rejects.toThrow("prior worker fenced");
  expect(setup.calls()).toBe(1);
  expect(setup.claims.size).toBe(1);
  const recovery = fixture();
  await runSharedReviewProbe(input, { ...recovery.context, origin: { ...recovery.context.origin, attemptId: "recovered-attempt" } });
  expect(recovery.calls()).toBe(1);
});

test("receipt failure settles both producer and waiting sibling without a duplicate execution", async () => {
  const setup = fixture();
  let executions = 0;
  const context = { ...setup.context,
    execute: async () => { executions += 1; return shell("sleep 0.02; printf 'executed'"); },
    evidence: { readTextFile: setup.context.evidence.readTextFile, async writeTextFile() { throw new Error("receipt write failed"); } },
  };
  const results = await Promise.allSettled([runSharedReviewProbe(input, context), runSharedReviewProbe(input, context)]);
  expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
  expect(String((results[1] as PromiseRejectedResult).reason)).toContain("outcome is unknown");
  expect(executions).toBe(1);
  await expect(runSharedReviewProbe(input, context)).rejects.toThrow("outcome is unknown");
  expect(executions).toBe(1);
});

test("forged or corrupted cached receipt cannot replace observed execution evidence", async () => {
  const setup = fixture();
  const first = await runSharedReviewProbe(input, setup.context);
  const latest = first.receiptPath.replace(/[^/]+$/, "latest.json");
  setup.files.set(latest, JSON.stringify({ ...first.receipt, result: { exitCode: 0, stdout: "forged", stderr: "" } }));
  await expect(runSharedReviewProbe(input, setup.context)).rejects.toThrow();
  expect(setup.calls()).toBe(1);
});

test("real filesystem observation covers ignored inputs, symlinks, tools and environment without emitting them", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-probe-")));
  try {
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, ".gitignore"), "node_modules\n");
    await writeFile(join(root, "node_modules", "fixture.js"), "version one");
    const observe = async (prefix = "") => {
      const result = await shell(prefix + reviewProbeSnapshotCommandFor(root));
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout) as { sourceDigest: string; environmentDigest: string; unobservedInputs: boolean };
    };
    const first = await observe();
    await writeFile(join(root, "node_modules", "fixture.js"), "version two");
    const changed = await observe();
    expect(changed.sourceDigest).not.toBe(first.sourceDigest);
    const environment = await observe("export PROBE_SCENARIO='private fixture value'; ");
    expect(environment.environmentDigest).not.toBe(changed.environmentDigest);
    expect(JSON.stringify(environment)).not.toContain("private fixture value");
    await symlink(tmpdir(), join(root, "external"));
    const external = await observe();
    expect(preparedProbeObservation(external, { tools: [] }, input.command).reuse).toBe("fresh");
    const prepared1 = preparedProbeObservation(changed, { tools: [{ name: "bun", version: "1" }] }, input.command);
    const prepared2 = preparedProbeObservation(changed, { tools: [{ name: "bun", version: "2" }] }, input.command);
    expect(prepared1.environmentDigest).not.toBe(prepared2.environmentDigest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("real command runner preserves shell/stdin/environment values and rejects escaping cwd symlinks", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "review-command-")));
  try {
    const value = "literal $(touch surprise) `touch surprise` 'quoted'\nsecond line";
    const result = await shell(reviewProbeCommand({ ...input, command: 'cat; printf "%s" "$SCENARIO"', stdin: "first\n", environment: [{ name: "SCENARIO", value }] }, root));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`first\n${value}`);
    await expect(readFile(join(root, "surprise"))).rejects.toThrow();
    await symlink(tmpdir(), join(root, "external"));
    expect((await shell(reviewProbeCommand({ ...input, command: "pwd", cwd: "external" }, root))).exitCode).toBe(126);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("setup head and incidental elapsed time do not invalidate an unchanged toolchain observation", async () => {
  const { environmentSetupSchema } = await import("../src/review/environment-setup");
  const raw = { sourceDigest: "1".repeat(64), environmentDigest: "2".repeat(64), unobservedInputs: false };
  const setup = environmentSetupSchema.parse({ revision: "review-environment-v2-isolated-acquisition", headSha: "a".repeat(40), inputsDigest: "3".repeat(64), tools: [{ name: "bun", version: "1.4.2" }], completedSteps: ["bun install --frozen-lockfile"], browser: { provider: "agent-browser", command: "/usr/local/bin/agent-browser", version: "0.37.1" } });
  const first = preparedProbeObservation(raw, { ...setup, durationMs: 10, completedAt: "2026-09-13T10:00:00Z" }, "bun test");
  const later = preparedProbeObservation(raw, { ...setup, headSha: "b".repeat(40), durationMs: 90, completedAt: "2026-09-13T10:02:00Z" }, "bun test");
  expect(later).toEqual(first);
  expect(preparedProbeObservation(raw, { ...setup, tools: [{ name: "bun", version: "1.4.3" }] }, "bun test")).not.toEqual(first);
  expect(preparedProbeObservation(raw, { ...setup, inputsDigest: "4".repeat(64) }, "bun test")).not.toEqual(first);
});

test("current consumption accepts fresh and earlier-origin results while paging preserves all output", async () => {
  const { recordWorkProbeReceipt, readWorkProbeConsumption, validateCurrentWorkProbeReceipts, reviewProbeOutputPage } = await import("../src/review/probe-execution");
  const setup = fixture();
  const output = "complete observed result\n".repeat(1_200);
  const result = await runSharedReviewProbe({ ...input, rerun: true }, { ...setup.context, observe: async () => ({ ...observation, reuse: "fresh" }), execute: async () => ({ exitCode: 0, stdout: output, stderr: "diagnostic" }) });
  expect(result.receipt.reusable).toBe(false);
  const fingerprint = "a".repeat(64), workId = "b".repeat(64);
  await recordWorkProbeReceipt(setup.context.evidence, setup.context.claims, fingerprint, workId, result.receipt, undefined, "current-consumer");
  const consumption = await readWorkProbeConsumption(setup.context.evidence, fingerprint, workId);
  expect(await validateCurrentWorkProbeReceipts(setup.context.evidence, "current-consumer", [result.receipt], consumption)).toBe(true);
  expect(await validateCurrentWorkProbeReceipts(setup.context.evidence, "wrong-attempt", [result.receipt], consumption)).toBe(false);
  expect(result.receipt.origin.attemptId).toBe("attempt");
  let reconstructed = "", cursor: number | null = 0;
  do { const page = reviewProbeOutputPage(result.receipt, "stdout", cursor); reconstructed += page.content; cursor = page.nextCursor; } while (cursor !== null);
  expect(reconstructed).toBe(output);
  setup.files.delete(result.receiptPath);
  expect(await validateCurrentWorkProbeReceipts(setup.context.evidence, "current-consumer", [result.receipt], consumption)).toBe(false);
});
