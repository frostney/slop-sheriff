import { expect, test } from "bun:test";
import { asSchema, generateText, stepCountIs, tool } from "ai";
import { mockModel } from "eve/evals";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inspectReviewSourceInputSchema, observeReviewSource, sourceObservationPage,
  sourceObservationSchema, validateSourceObservations,
} from "../src/review/source-observations";

async function git(root: string, ...args: string[]) {
  const process = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", env: {
    ...Bun.env, GIT_AUTHOR_NAME: "Probe Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Probe Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  } });
  const [code, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
const sandbox = { async run({ command }: { command: string }) {
  const process = Bun.spawn(["/bin/bash", "-c", command], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { exitCode, stdout, stderr };
} };

test("supporting-source and search receipts revalidate exact content across real Git commits", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "source-observation-")));
  try {
    await git(root, "init", "--quiet");
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "support.ts"), "export const support = 'one';\n");
    await writeFile(join(root, "src", "subject.ts"), "export const implementation = support;\n");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 255, 42]));
    await git(root, "add", "."); await git(root, "commit", "--quiet", "-m", "initial fixture");
    const head = await git(root, "rev-parse", "HEAD");
    const revisions = { baseSha: head, headSha: head };
    const read = await observeReviewSource(sandbox, revisions, { operation: "read", revision: "head", path: "src/support.ts", query: null, cursor: null }, root);
    const query = await observeReviewSource(sandbox, revisions, { operation: "search", revision: "head", path: null, query: "implementation", cursor: null }, root);
    const absent = await observeReviewSource(sandbox, revisions, { operation: "search", revision: "head", path: null, query: "nonexistentFeature", cursor: null }, root);
    const missing = await observeReviewSource(sandbox, revisions, { operation: "read", revision: "head", path: "src/missing.ts", query: null, cursor: null }, root);
    const binary = await observeReviewSource(sandbox, revisions, { operation: "read", revision: "head", path: "binary.bin", query: null, cursor: null }, root);
    expect(read.content).toContain("'one'");
    expect(query.content).toBe("src/subject.ts:1:export const implementation = support;\n");
    expect(absent.negative).toBe(true);
    expect(missing.kind).toBe("missing");
    expect(binary.binary).toBe(true);
    expect(binary.content).toContain("3 bytes");
    await writeFile(join(root, "README.md"), "unrelated text\n");
    await git(root, "add", "."); await git(root, "commit", "--quiet", "-m", "unrelated file");
    const next = { baseSha: head, headSha: await git(root, "rev-parse", "HEAD") };
    expect(await validateSourceObservations(sandbox, next, [read, query, missing], root)).toBe(true);
    expect(await validateSourceObservations(sandbox, next, [absent], root)).toBe(false);
    await writeFile(join(root, "src", "support.ts"), "export const support = 'changed';\n");
    await writeFile(join(root, "src", "missing.ts"), "new implementation\n");
    await git(root, "add", "."); await git(root, "commit", "--quiet", "-m", "supporting change");
    const changed = { baseSha: head, headSha: await git(root, "rev-parse", "HEAD") };
    expect(await validateSourceObservations(sandbox, changed, [read], root)).toBe(false);
    expect(await validateSourceObservations(sandbox, changed, [query], root)).toBe(false);
    expect(await validateSourceObservations(sandbox, changed, [missing], root)).toBe(false);
    const baseRead = await observeReviewSource(sandbox, changed, { operation: "read", revision: "base", path: "src/support.ts", query: null, cursor: null }, root);
    expect(baseRead.outputDigest).toBe(read.outputDigest);
    expect(sourceObservationSchema.safeParse({ ...read, content: "model-authored replacement" }).success).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("literal queries and Git blob reads do not execute repository strings or shell metacharacters", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "source-literal-")));
  try {
    await git(root, "init", "--quiet");
    const literal = "$(touch untrusted) `touch other` 'quote'";
    await writeFile(join(root, "fixture.txt"), `${literal}\n${"x".repeat(9000)}`);
    await git(root, "add", "."); await git(root, "commit", "--quiet", "-m", "literal fixture");
    const head = await git(root, "rev-parse", "HEAD");
    const revisions = { baseSha: head, headSha: head };
    const search = await observeReviewSource(sandbox, revisions, { operation: "search", revision: "head", path: null, query: literal, cursor: null }, root);
    expect(search.content).toContain(literal);
    expect(await git(root, "status", "--porcelain")).toBe("");
    const read = await observeReviewSource(sandbox, revisions, { operation: "read", revision: "head", path: "fixture.txt", query: null, cursor: null }, root);
    const first = sourceObservationPage(read, null);
    const second = sourceObservationPage(read, first.nextCursor);
    expect(first.content + second.content).toBe(read.content);
    expect(second.nextCursor).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("actual source tool JSON Schema and official Eve mock reject model-authored revision provenance", async () => {
  const schema = await asSchema(inspectReviewSourceInputSchema).jsonSchema;
  expect(schema).toHaveProperty("additionalProperties", false);
  for (const field of ["commitSha", "treeSha", "outputDigest", "workId", "scope", "observations"]) expect(schema).not.toHaveProperty(`properties.${field}`);
  const input = { operation: "search", revision: "head", path: null, query: "implementation", cursor: null };
  let calls = 0;
  let executions = 0;
  await generateText({
    model: mockModel(() => ++calls === 1 ? { toolCalls: [{ name: "inspect_review_source", input: { ...input, commitSha: "forged" } }] }
      : calls === 2 ? { toolCalls: [{ name: "inspect_review_source", input }] } : "done"),
    prompt: "Inspect source", stopWhen: stepCountIs(3),
    tools: { inspect_review_source: tool({ inputSchema: inspectReviewSourceInputSchema, execute: async () => { executions += 1; return "observed"; } }) },
  });
  expect(executions).toBe(1);
  for (const invalid of [{ ...input, path: "src/a.ts" }, { ...input, query: "a\nb" }, { ...input, operation: "read" }, { ...input, operation: "read", query: null, path: "../escape" }]) {
    expect(inspectReviewSourceInputSchema.safeParse(invalid).success).toBe(false);
  }
});
