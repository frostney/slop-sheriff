import { createHash } from "node:crypto";
import { z } from "zod";
import type { TextSandbox } from "./authenticated-evidence";
import { repositoryPathSchema } from "./evidence-bundle";
import { withReviewEvidenceLock, type ProbeClaims } from "./probe-execution";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);
const requestSchema = z.strictObject({
  operation: z.enum(["read", "search"]), revision: z.enum(["base", "head"]),
  path: repositoryPathSchema.nullable(),
  query: z.string().min(1).refine(value => !/[\0\r\n]/.test(value)).nullable(),
});
function validOperation(input: z.infer<typeof requestSchema>, ctx: z.RefinementCtx): void {
  if (input.operation === "read" && (input.path === null || input.query !== null)) ctx.addIssue({ code: "custom", message: "Read requires a path and null query" });
  if (input.operation === "search" && (input.query === null || input.path !== null)) ctx.addIssue({ code: "custom", message: "Search requires a literal query and null path; its scope is all tracked text" });
}
const cursorSchema = z.number().int().nonnegative().nullable().describe("Character offset in the complete recorded source or search results; null starts at zero.");
const sourceInspectionRequestSchema = requestSchema.extend({
  cursor: cursorSchema,
}).superRefine(validOperation);
export type SourceInspectionInput = z.infer<typeof sourceInspectionRequestSchema>;
export const inspectReviewSourceInputSchema = z.strictObject({
  revision: z.enum(["base", "head"]), cursor: cursorSchema,
  target: z.union([
    z.strictObject({ operation: z.literal("read"), path: repositoryPathSchema }),
    z.strictObject({ operation: z.literal("search"), query: z.string().min(1).regex(/^[^\0\r\n]+$/).describe("Literal text to search across every tracked text file. Search is not restricted to a path.") }),
  ]),
});
export function sourceInspectionRequest(input: z.infer<typeof inspectReviewSourceInputSchema>): SourceInspectionInput {
  const common = { revision: input.revision, cursor: input.cursor };
  return input.target.operation === "read"
    ? { ...common, ...input.target, query: null }
    : { ...common, ...input.target, path: null };
}

export const sourceObservationSchema = z.strictObject({
  schemaVersion: z.literal(1), id: fingerprintSchema,
  request: requestSchema.superRefine(validOperation),
  commitSha: revisionSchema, treeSha: revisionSchema,
  kind: z.enum(["blob", "tree", "missing", "search"]),
  objectId: revisionSchema.nullable(), mode: z.string().nullable(),
  scope: z.literal("tracked-repository"),
  outputDigest: fingerprintSchema, content: z.string(), binary: z.boolean(), negative: z.boolean(),
}).superRefine((observation, ctx) => {
  const { id, ...payload } = observation;
  if (hash(payload) !== id) ctx.addIssue({ code: "custom", message: "Source observation digest mismatch" });
});
export type SourceObservation = z.infer<typeof sourceObservationSchema>;
export interface SourceObservationSandbox {
  run(input: { command: string }): PromiseLike<{ exitCode: number; stdout: unknown; stderr: unknown }>;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function quote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }
function git(argumentsSource: string, root: string): string {
  return `set -o pipefail; GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 git --no-replace-objects -c core.quotePath=false -C ${quote(root)} ${argumentsSource}`;
}
async function run(sandbox: SourceObservationSandbox, command: string, allowNoMatch = false): Promise<string> {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0 && !(allowNoMatch && result.exitCode === 1)) throw new Error(`Exact source observation failed (${result.exitCode}): ${String(result.stderr)}`);
  return String(result.stdout);
}

/** Commands and revision identities are constructed by the application, not the model. */
export async function observeReviewSource(sandbox: SourceObservationSandbox, revisions: { baseSha: string; headSha: string }, input: SourceInspectionInput, workspaceRoot = "/workspace"): Promise<SourceObservation> {
  const parsed = sourceInspectionRequestSchema.parse(input);
  const { cursor: _cursor, ...request } = parsed;
  const commitSha = revisionSchema.parse(revisions[request.revision === "base" ? "baseSha" : "headSha"]);
  const treeSha = revisionSchema.parse((await run(sandbox, git(`rev-parse --verify ${quote(`${commitSha}^{tree}`)}`, workspaceRoot))).trim());
  let kind: SourceObservation["kind"];
  let content: string;
  let objectId: string | null = null;
  let mode: string | null = null;
  let binary = false;
  let negative = false;
  let outputDigest: string;
  if (request.operation === "search") {
    const output = await run(sandbox, git(`grep --no-textconv --full-name -n -I -F -e ${quote(request.query!)} ${quote(commitSha)} --`, workspaceRoot), true);
    // The selected revision prefix is provenance, not semantic query output.
    content = output.split("\n").map(line => line.startsWith(`${commitSha}:`) ? line.slice(commitSha.length + 1) : line).join("\n");
    kind = "search";
    negative = content.length === 0;
    outputDigest = hash(["literal-tracked-text-query-v1", content]);
  } else {
    const entry = await run(sandbox, git(`--literal-pathspecs ls-tree -z ${quote(commitSha)} -- ${quote(request.path!)}`, workspaceRoot));
    const match = /^(\d+) (blob|tree|commit) ([a-f0-9]{40})\t/.exec(entry);
    if (!entry) {
      kind = "missing"; content = ""; negative = true;
      outputDigest = hash(["missing", request.path]);
    } else {
      if (!match || match[2] === "commit") throw new Error("Source inspection cannot resolve this submodule; inspect its prepared checkout through an executable probe");
      mode = match[1]!; objectId = match[3]!;
      if (match[2] === "tree") {
        kind = "tree";
        content = (await run(sandbox, git(`ls-tree -r ${quote(objectId)}`, workspaceRoot)));
        outputDigest = hash([kind, mode, objectId, content]);
      } else {
        kind = "blob";
        const encoded = await run(sandbox, `${git(`cat-file blob ${quote(objectId)}`, workspaceRoot)} | base64`);
        const bytes = Buffer.from(encoded.replaceAll(/\s/g, ""), "base64");
        binary = bytes.includes(0);
        content = binary ? `Binary blob ${objectId}; ${bytes.length} bytes.` : bytes.toString("utf8");
        outputDigest = hash([kind, mode, objectId, createHash("sha256").update(bytes).digest("hex")]);
      }
    }
  }
  const payload = { schemaVersion: 1 as const, request, commitSha, treeSha, kind, objectId, mode, scope: "tracked-repository" as const, outputDigest, content, binary, negative };
  return sourceObservationSchema.parse({ ...payload, id: hash(payload) });
}

export function workSourceObservationsPath(fingerprint: string, workId: string): string {
  return `/tmp/known-good-review/work/${fingerprintSchema.parse(fingerprint)}/${fingerprintSchema.parse(workId)}/sources.json`;
}
export async function readWorkSourceObservations(evidence: TextSandbox, fingerprint: string, workId: string): Promise<SourceObservation[]> {
  const raw = await evidence.readTextFile({ path: workSourceObservationsPath(fingerprint, workId) });
  return raw === null ? [] : sourceObservationSchema.array().parse(JSON.parse(raw));
}
export async function recordWorkSourceObservation(evidence: TextSandbox, claims: ProbeClaims, fingerprint: string, workId: string, observation: SourceObservation, signal?: AbortSignal): Promise<void> {
  const path = workSourceObservationsPath(fingerprint, workId);
  await withReviewEvidenceLock(claims, path, async () => {
    const prior = await readWorkSourceObservations(evidence, fingerprint, workId);
    if (!prior.some(item => item.id === observation.id)) await evidence.writeTextFile({ path, content: JSON.stringify([...prior, sourceObservationSchema.parse(observation)]) });
  }, signal);
}

/** Re-execute searches, including negative evidence, against the current tree. */
export async function validateSourceObservations(sandbox: SourceObservationSandbox, revisions: { baseSha: string; headSha: string }, observations: readonly SourceObservation[], workspaceRoot = "/workspace"): Promise<boolean> {
  for (const raw of observations) {
    const previous = sourceObservationSchema.parse(raw);
    const current = await observeReviewSource(sandbox, revisions, { ...previous.request, cursor: null }, workspaceRoot);
    if (current.outputDigest !== previous.outputDigest) return false;
    // Absence is scoped evidence. New files invalidate a negative search even
    // when they spell an implementation differently from the original query.
    if (previous.kind === "search" && previous.negative && current.treeSha !== previous.treeSha) return false;
  }
  return true;
}

export function sourceObservationPage(observation: SourceObservation, cursor: number | null) {
  const start = cursor ?? 0;
  const content = observation.content.slice(start, start + 8_000);
  return { observationId: observation.id, kind: observation.kind, path: observation.request.path, query: observation.request.query,
    commitSha: observation.commitSha, treeSha: observation.treeSha, outputDigest: observation.outputDigest,
    binary: observation.binary, negative: observation.negative, scope: observation.scope,
    content, totalCharacters: observation.content.length, nextCursor: start + content.length < observation.content.length ? start + content.length : null };
}
