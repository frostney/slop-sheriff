import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { TextSandbox } from "./authenticated-evidence";
import { artifactRequest } from "./durable-evidence";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const environmentEntrySchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().refine(value => !value.includes("\0")),
});
export const runReviewProbeInputSchema = z.strictObject({
  command: z.string().min(1).refine(value => !value.includes("\0")).describe("The complete test or behavioral probe command, including all assertions and scenario arguments."),
  cwd: z.string().regex(/^(?:\.|[A-Za-z0-9_.@+ -]+(?:\/[A-Za-z0-9_.@+ -]+)*)$/)
    .refine(value => !value.split("/").some(part => part === ".." || part === ".git"))
    .describe("Working directory relative to the prepared repository; use . for its root."),
  stdin: z.string().nullable().describe("Exact standard input, or null for empty input."),
  environment: z.array(environmentEntrySchema).superRefine((entries, ctx) => {
    if (new Set(entries.map(entry => entry.name)).size !== entries.length) ctx.addIssue({ code: "custom", message: "Environment variable names must be unique" });
  }).describe("Explicit sandbox environment overrides. Never include credentials."),
  rerun: z.boolean().describe("True requests a new independent execution, including repeated or flaky sampling. False may reuse one matching observed execution."),
});
export type ReviewProbeInput = z.infer<typeof runReviewProbeInputSchema>;

/** Only application code supplies these observations. They are absent from tool input. */
export const probeObservationSchema = z.strictObject({
  sourceDigest: digestSchema, environmentDigest: digestSchema,
  externalStateDigest: digestSchema.nullable(),
  reuse: z.enum(["same-snapshot", "fresh"]),
});
export type ProbeObservation = z.infer<typeof probeObservationSchema>;
const outputSchema = z.strictObject({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() });
const receiptPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), probeId: digestSchema, executionId: z.string().uuid(),
  origin: z.strictObject({ attemptId: z.string().min(1), sessionId: z.string().min(1), callId: z.string().min(1) }),
  input: runReviewProbeInputSchema, before: probeObservationSchema, after: probeObservationSchema.nullable(),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  status: z.enum(["completed", "interrupted"]), result: outputSchema.nullable(),
  reusable: z.boolean(), error: z.string().nullable(),
});
export const reviewProbeReceiptSchema = receiptPayloadSchema.extend({ digest: digestSchema }).superRefine((receipt, ctx) => {
  const { digest: recorded, ...payload } = receipt;
  if (digest(payload) !== recorded) ctx.addIssue({ code: "custom", message: "Probe receipt digest mismatch" });
  if ((receipt.status === "completed") !== (receipt.result !== null)) ctx.addIssue({ code: "custom", message: "Completed probes require an observed result" });
  if (receipt.reusable && (receipt.status !== "completed" || receipt.before.reuse !== "same-snapshot" || digest(receipt.before) !== digest(receipt.after))) {
    ctx.addIssue({ code: "custom", message: "Reusable probes require unchanged observed inputs and environment" });
  }
});
export type ReviewProbeReceipt = z.infer<typeof reviewProbeReceiptSchema>;
export interface ReviewProbeResult { receipt: ReviewProbeReceipt; receiptPath: string; reused: boolean }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function normalizeInput(input: ReviewProbeInput): ReviewProbeInput {
  return { ...input, stdin: input.stdin ?? "", environment: [...input.environment].sort((a, b) => a.name.localeCompare(b.name)) };
}
export function reviewProbeIdentity(repositoryId: string, input: ReviewProbeInput, observation: ProbeObservation): string {
  const { rerun: _rerun, ...executionInput } = normalizeInput(runReviewProbeInputSchema.parse(input));
  return digest({ revision: "shared-review-probe-v1", repositoryId, input: executionInput, observation: probeObservationSchema.parse(observation) });
}
export function reviewProbeDirectory(probeId: string): string { return `/tmp/known-good-review/probes/${digestSchema.parse(probeId)}`; }
export function reviewProbeReceiptPath(probeId: string, executionId: string): string {
  return `${reviewProbeDirectory(probeId)}/${z.string().uuid().parse(executionId)}.json`;
}

export interface ProbeClaims {
  claim(path: string, owner: string): Promise<{ acquired: boolean; owner: string }>;
  release(path: string, owner: string): Promise<void>;
  fail(path: string, owner: string): Promise<void>;
  assertHealthy(path: string, owner: string): Promise<void>;
  assertCurrent(): Promise<void>;
}
export function durableProbeClaims(attemptId: string, request = artifactRequest): ProbeClaims {
  return {
    async claim(path, owner) { return z.strictObject({ acquired: z.boolean(), owner: z.string().uuid() }).parse(await request("probe-claim", { attemptId, path, owner })); },
    async release(path, owner) { await request("probe-release", { attemptId, path, owner }); },
    async fail(path, owner) { await request("probe-fail", { attemptId, path, owner }); },
    async assertHealthy(path, owner) { await request("probe-assert-healthy", { attemptId, path, owner }); },
    async assertCurrent() { await request("probe-assert-current", { attemptId }); },
  };
}

/** Serialize signed index updates through the same authoritative claim primitive. */
export async function withReviewEvidenceLock<T>(claims: ProbeClaims, identity: unknown, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const path = reviewProbeDirectory(digest(["work-evidence-index-v1", identity]));
  const owner = randomUUID();
  for (;;) {
    signal?.throwIfAborted();
    const claim = await claims.claim(path, owner);
    if (claim.acquired) break;
    await claims.assertHealthy(path, claim.owner);
    await delay(250, undefined, { signal });
  }
  try {
    const result = await action();
    await claims.release(path, owner);
    return result;
  } catch (error) {
    await claims.fail(path, owner);
    throw error;
  }
}

export function workProbeReceiptsPath(fingerprint: string, workId: string): string {
  return `/tmp/known-good-review/work/${digestSchema.parse(fingerprint)}/${digestSchema.parse(workId)}/probes.json`;
}
export async function readWorkProbeReceipts(evidence: TextSandbox, fingerprint: string, workId: string): Promise<ReviewProbeReceipt[]> {
  const raw = await evidence.readTextFile({ path: workProbeReceiptsPath(fingerprint, workId) });
  return raw === null ? [] : reviewProbeReceiptSchema.array().parse(JSON.parse(raw));
}
export const probeConsumptionSchema = z.strictObject({ receiptDigest: digestSchema, attemptId: z.string().min(1) });
export async function readWorkProbeConsumption(evidence: TextSandbox, fingerprint: string, workId: string) {
  const raw = await evidence.readTextFile({ path: workProbeReceiptsPath(fingerprint, workId).replace(/probes.json$/, "probe-consumption.json") });
  return raw === null ? [] : probeConsumptionSchema.array().parse(JSON.parse(raw));
}
export async function recordWorkProbeReceipt(evidence: TextSandbox, claims: ProbeClaims, fingerprint: string, workId: string, receipt: ReviewProbeReceipt, signal?: AbortSignal, consumerAttemptId = receipt.origin.attemptId): Promise<void> {
  const path = workProbeReceiptsPath(fingerprint, workId);
  await withReviewEvidenceLock(claims, path, async () => {
    const prior = await readWorkProbeReceipts(evidence, fingerprint, workId);
    if (!prior.some(item => item.executionId === receipt.executionId)) {
      await evidence.writeTextFile({ path, content: JSON.stringify([...prior, reviewProbeReceiptSchema.parse(receipt)]) });
    }
    const consumption = await readWorkProbeConsumption(evidence, fingerprint, workId);
    const next = [...consumption.filter(item => item.receiptDigest !== receipt.digest), probeConsumptionSchema.parse({ receiptDigest: receipt.digest, attemptId: consumerAttemptId })];
    await evidence.writeTextFile({ path: path.replace(/probes.json$/, "probe-consumption.json"), content: JSON.stringify(next) });
  }, signal);
}

export interface SharedProbeExecution {
  readonly repositoryId: string;
  readonly origin: ReviewProbeReceipt["origin"];
  /** The authenticated evidence reader, never the raw repository filesystem. */
  readonly evidence: TextSandbox;
  readonly claims: ProbeClaims;
  readonly observe: () => Promise<ProbeObservation>;
  readonly execute: (input: ReviewProbeInput) => Promise<z.infer<typeof outputSchema>>;
  readonly signal?: AbortSignal | undefined;
}

/** Share an observed execution, not a model assertion about test success or purity. */
export async function runSharedReviewProbe(rawInput: ReviewProbeInput, context: SharedProbeExecution): Promise<ReviewProbeResult> {
  const input = normalizeInput(runReviewProbeInputSchema.parse(rawInput));
  context.signal?.throwIfAborted();
  await context.claims.assertCurrent();
  const before = probeObservationSchema.parse(await context.observe());
  const probeId = reviewProbeIdentity(context.repositoryId, input, before);
  const directory = reviewProbeDirectory(probeId);
  const latestPath = `${directory}/latest.json`;
  const readReceipt = async (path: string) => {
    const raw = await context.evidence.readTextFile({ path });
    if (raw === null) return null;
    const receipt = reviewProbeReceiptSchema.parse(JSON.parse(raw));
    if (receipt.probeId !== probeId || digest(receipt.before) !== digest(before) ||
      reviewProbeIdentity(context.repositoryId, receipt.input, receipt.before) !== probeId) throw new Error("Probe receipt input identity mismatch");
    return receipt;
  };
  const reusable = async (): Promise<ReviewProbeResult | null> => {
    if (input.rerun || before.reuse !== "same-snapshot") return null;
    const receipt = await readReceipt(latestPath);
    await context.claims.assertCurrent();
    return receipt?.reusable ? { receipt, receiptPath: reviewProbeReceiptPath(probeId, receipt.executionId), reused: true } : null;
  };
  const previous = await reusable();
  if (previous) return previous;
  const executionId = randomUUID();
  // Explicit independent sampling must not join a sibling's observation.
  const claimPath = input.rerun || before.reuse === "fresh" ? reviewProbeDirectory(digest([probeId, executionId])) : directory;
  const claim = await context.claims.claim(claimPath, executionId);
  if (!claim.acquired) {
    const receiptPath = reviewProbeReceiptPath(probeId, claim.owner);
    for (;;) {
      context.signal?.throwIfAborted();
      await context.claims.assertCurrent();
      const receipt = await readReceipt(receiptPath);
      if (receipt) {
        await context.claims.assertCurrent();
        if (receipt.status === "interrupted") throw new Error(`Shared probe execution interrupted: ${receipt.error}`);
        return { receipt, receiptPath, reused: true };
      }
      await context.claims.assertHealthy(claimPath, claim.owner);
      // Polling releases compute between I/O requests; there is no execution TTL.
      await delay(250, undefined, { signal: context.signal });
    }
  }
  let committed = false;
  try {
    // Another worker may have completed between the first read and our claim.
    const completed = await reusable();
    if (completed) { committed = true; return completed; }
    const startedAt = new Date().toISOString();
    let result: z.infer<typeof outputSchema> | null = null;
    let after: ProbeObservation | null = null;
    let error: string | null = null;
    try {
      result = outputSchema.parse(await context.execute(input));
      after = probeObservationSchema.parse(await context.observe());
    } catch (failure) {
      // A transport failure has no trustworthy exit code. Preserve that fact.
      error = failure instanceof Error ? failure.message : String(failure);
    }
    const payload = receiptPayloadSchema.parse({
      schemaVersion: 1, probeId, executionId, origin: context.origin, input, before, after,
      startedAt, finishedAt: new Date().toISOString(), status: error === null ? "completed" : "interrupted",
      result: error === null ? result : null, error,
      reusable: error === null && before.reuse === "same-snapshot" && digest(before) === digest(after),
    });
    const receipt = reviewProbeReceiptSchema.parse({ ...payload, digest: digest(payload) });
    const receiptPath = reviewProbeReceiptPath(probeId, executionId);
    await context.evidence.writeTextFile({ path: receiptPath, content: JSON.stringify(receipt) });
    if (receipt.reusable) await context.evidence.writeTextFile({ path: latestPath, content: JSON.stringify(receipt) });
    committed = true;
    if (error !== null) throw new Error(`Review probe execution interrupted: ${error}`);
    return { receipt, receiptPath, reused: false };
  } catch (failure) {
    if (!committed) await context.claims.fail(claimPath, executionId);
    throw failure;
  } finally {
    // A failed receipt write leaves ownership in place. Recovery must fence the
    // old worker; silently releasing here could duplicate an unknown outcome.
    if (committed) await context.claims.release(claimPath, executionId);
  }
}

function quote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
export function reviewProbeCommand(input: ReviewProbeInput, workspaceRoot = "/workspace"): string {
  const parsed = normalizeInput(runReviewProbeInputSchema.parse(input));
  const environment = parsed.environment.map(entry => quote(`${entry.name}=${entry.value}`)).join(" ");
  return `cd ${quote(`${workspaceRoot}/${parsed.cwd}`)} && case "$(pwd -P)" in ${quote(workspaceRoot)}|${quote(`${workspaceRoot}/`)}*) ;; *) exit 126 ;; esac && printf '%s' ${quote(Buffer.from(parsed.stdin ?? "").toString("base64"))} | base64 -d | env ${environment} /bin/bash -c ${quote(parsed.command)}`;
}

/** Conservative defaults: share common local checks, rerun live or opaque probes. */
export function reviewProbeReuse(command: string): ProbeObservation["reuse"] {
  if (/[;&|<>`\r\n]|\$\(|(?:^|\s|=)(?:\.\.\/|~\/|\$HOME)/.test(command) ||
    /(?:https?:\/\/|\b(?:curl|wget|ssh|date|watch|sleep|kill|ps|docker|kubectl)\b|\/dev\/(?:random|urandom)|\$RANDOM|--(?:watch|repeat|retries|flaky)\b)/i.test(command)) return "fresh";
  return /^(?:(?:bun|npm|pnpm|yarn)\s+(?:test(?=\s|$)|(?:run\s+)?(?:check|typecheck|lint|build)(?=\s|$))|(?:cargo|go|dotnet|swift)\s+(?:test|check|build)(?=\s|$)|(?:python3?\s+-m\s+)?pytest(?=\s|$)|(?:uv\s+run\s+)?pytest(?=\s|$)|(?:make|cmake|ctest)(?=\s|$)|git\s+diff\s+--check(?=\s|$))/.test(command.trim()) ? "same-snapshot" : "fresh";
}

/** Hash bytes, modes, symlinks and negative scope, including ignored probe inputs.
 * No source, environment values or credentials leave the sandbox in this output. */
export function reviewProbeSnapshotCommandFor(workspaceRoot = "/workspace"): string {
  return `python3 - <<'PY'
import hashlib, json, os, shutil, stat
workspace = ${JSON.stringify(workspaceRoot)}
if not os.path.isdir(workspace): raise RuntimeError('Prepared workspace is missing')
def hashed(value): return hashlib.sha256(value).hexdigest()
def file_digest(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''): digest.update(chunk)
    return digest.hexdigest()
entries = []
unobserved_inputs = False
def fail_walk(error): raise error
for root, directories, files in os.walk(workspace, followlinks=False, onerror=fail_walk):
    directories.sort()
    for name in sorted(directories + files):
        path = os.path.join(root, name)
        status = os.lstat(path)
        kind = stat.S_IFMT(status.st_mode)
        if stat.S_ISLNK(status.st_mode) and os.path.commonpath([os.path.realpath(path), workspace]) != workspace: unobserved_inputs = True
        if not (stat.S_ISLNK(status.st_mode) or stat.S_ISREG(status.st_mode) or stat.S_ISDIR(status.st_mode)): unobserved_inputs = True
        content = os.readlink(path) if stat.S_ISLNK(status.st_mode) else file_digest(path) if stat.S_ISREG(status.st_mode) else None
        entries.append([os.path.relpath(path, workspace), kind, stat.S_IMODE(status.st_mode), content])
tools = []
for name in ['bash', 'python3', 'bun', 'node', 'npm', 'pnpm', 'yarn', 'cargo', 'rustc', 'go', 'dotnet', 'fpc', 'lwpt', 'java', 'make', 'cmake', 'git', 'uv']:
    path = shutil.which(name)
    tools.append([name, os.path.realpath(path), file_digest(path)] if path and os.path.isfile(path) else [name, None])
environment = {key: value for key, value in os.environ.items() if key not in ['_', 'SHLVL']}
print(json.dumps({'sourceDigest': hashed(json.dumps(entries, separators=(',', ':')).encode()), 'environmentDigest': hashed(json.dumps([environment, tools, list(os.uname())], sort_keys=True, separators=(',', ':')).encode()), 'unobservedInputs': unobserved_inputs}))
PY`;
}
export const reviewProbeSnapshotCommand = reviewProbeSnapshotCommandFor();

export function preparedProbeObservation(raw: unknown, setup: unknown, command: string, environment: ReviewProbeInput["environment"] = []): ProbeObservation {
  const { unobservedInputs, ...observed } = z.strictObject({ sourceDigest: digestSchema, environmentDigest: digestSchema, unobservedInputs: z.boolean() }).parse(raw);
  const externalEnvironment = environment.some(entry => /^(?:PATH|HOME|BASH_ENV|ENV|NODE_OPTIONS|PYTHONPATH|LD_.+|DYLD_.+)$|(?:URL|ENDPOINT|TOKEN|SECRET|CREDENTIAL|PASSWORD|API_KEY)$/i.test(entry.name));
  const stable = z.object({ revision: z.string().optional(), inputsDigest: digestSchema.optional(),
    tools: z.array(z.object({ name: z.string(), version: z.string() })).optional(), completedSteps: z.array(z.string()).optional(),
    browser: z.object({ provider: z.string(), command: z.string(), version: z.string() }).optional(),
  }).parse(setup);
  if (stable.tools) stable.tools.sort((a, b) => a.name.localeCompare(b.name));
  if (stable.completedSteps) stable.completedSteps.sort();
  return { ...observed, environmentDigest: digest([observed.environmentDigest, stable]), externalStateDigest: null, reuse: unobservedInputs || externalEnvironment ? "fresh" : reviewProbeReuse(command) };
}

/** Current evidence may intentionally mutate fixtures or observe live state. */
export async function validateCurrentWorkProbeReceipts(evidence: TextSandbox, attemptId: string, receipts: readonly ReviewProbeReceipt[], consumption: readonly z.infer<typeof probeConsumptionSchema>[]): Promise<boolean> {
  for (const raw of receipts) {
    const receipt = reviewProbeReceiptSchema.parse(raw);
    if (receipt.status !== "completed" || !consumption.some(use => use.attemptId === attemptId && use.receiptDigest === receipt.digest)) return false;
    const stored = await evidence.readTextFile({ path: reviewProbeReceiptPath(receipt.probeId, receipt.executionId) });
    if (stored === null || reviewProbeReceiptSchema.parse(JSON.parse(stored)).digest !== receipt.digest) return false;
  }
  return true;
}

export async function validateWorkProbeReceipts(sandbox: { run(input: { command: string }): PromiseLike<{ exitCode: number; stdout: unknown; stderr: unknown }> }, setup: unknown, receipts: readonly ReviewProbeReceipt[]): Promise<boolean> {
  if (receipts.length === 0) return true;
  const observation = await sandbox.run({ command: reviewProbeSnapshotCommand });
  if (observation.exitCode !== 0) throw new Error("Cannot validate prior probe input/environment observations");
  const raw: unknown = JSON.parse(String(observation.stdout));
  return receipts.every(value => {
    const receipt = reviewProbeReceiptSchema.parse(value);
    return receipt.reusable && receipt.status === "completed" &&
      digest(preparedProbeObservation(raw, setup, receipt.input.command, receipt.input.environment)) === digest(receipt.before);
  });
}

/** Paging limits transport size, never coverage or the durable observed output. */
export function reviewProbeOutputPage(receipt: ReviewProbeReceipt, stream: "stdout" | "stderr", cursor: number | null) {
  const offset = z.number().int().nonnegative().parse(cursor ?? 0);
  const content = receipt.result?.[stream] ?? "";
  return { probeId: receipt.probeId, executionId: receipt.executionId, receiptDigest: receipt.digest, stream,
    content: content.slice(offset, offset + 8_000), totalCharacters: content.length,
    nextCursor: offset + 8_000 < content.length ? offset + 8_000 : null };
}
