import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readWorkRevisionTree } from "../src/review/work-inputs";
import { reportRepositoryDigest } from "../src/review/report-repository-identity";

const setup = { revision: "prepared-v1", inputsDigest: "ab".repeat(32), tools: [{ name: "node", version: "24.1" }], completedSteps: ["dependencies"] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "report-repository-"));
  const sandbox = { async run({ command }: { command: string }) {
    const child = Bun.spawn(["bash", "-c", command.replaceAll("/workspace", root)], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  } };
  async function git(command: string) {
    const result = await sandbox.run({ command: `git ${command}` });
    if (result.exitCode) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  await git("init --quiet"); await git("config user.name Fixture"); await git("config user.email fixture@example.test");
  async function commit(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root,path)), {recursive:true}); await writeFile(join(root,path), content); }
    await git("add ."); await git("commit --quiet -m fixture"); return git("rev-parse HEAD");
  }
  const base = await commit({ ".github/slop-sheriff.yml": "voice: theatrical\nvoiceGuide: docs/voice.md\n", "docs/voice.md": "Howdy", "src/a.ts": "export const a = 1;", "support/outside.ts": "export const limit = 1;" });
  const head = await commit({ "src/a.ts": "export const a = 2;" });
  async function digest(baseSha = base, headSha = head, environment: unknown = setup) {
    return reportRepositoryDigest({ sandbox, base: await readWorkRevisionTree(sandbox, baseSha), head: await readWorkRevisionTree(sandbox, headSha), requirements: [], setup: environment });
  }
  return { root, sandbox, base, head, commit, digest, cleanup: () => rm(root, {recursive:true, force:true}) };
}

test("same tracked code and setup allow only presentation config and guide changes", async () => {
  const f = await fixture();
  try {
    const before = await f.digest();
    const head = await f.commit({ ".github/slop-sheriff.yml": "voice: understated\nvoiceGuide: docs/voice.md\ntasks:\n  presentation:\n    model: openai/gpt-5.6-sol\n", "docs/voice.md": "Plain language" });
    expect(await f.digest(f.base, head)).toBe(before);
    expect(await f.digest(f.base, head, { ...setup, headSha: head })).toBe(before);
    const changedBase = await f.commit({ "src/a.ts": "export const a = 1;" });
    const changedHead = await f.commit({ "src/a.ts": "export const a = 2;" });
    expect(await f.digest(changedBase, changedHead)).toBe(before);
  } finally { await f.cleanup(); }
});

test("support outside every component and either tracked tree invalidates equivalence", async () => {
  const f = await fixture();
  try {
    const before = await f.digest();
    const head = await f.commit({ "support/outside.ts": "export const limit = 2;" });
    expect(await f.digest(f.base, head)).not.toBe(before);
    expect(await f.digest(head, f.head)).not.toBe(before);
  } finally { await f.cleanup(); }
});

test("guide referenced by analysis and nonpresentation config remain tracked inputs", async () => {
  const f = await fixture();
  try {
    const base = await f.commit({ ".github/slop-sheriff.yml": "voice: theatrical\nvoiceGuide: docs/voice.md\nrequirementPaths: [docs]\n" });
    const before = await f.digest(base, base);
    const head = await f.commit({ "docs/voice.md": "This guide is also the specification" });
    expect(await f.digest(base, head)).not.toBe(before);
    const analysisHead = await f.commit({ ".github/slop-sheriff.yml": "voice: theatrical\nvoiceGuide: docs/voice.md\nprofile: thorough\n" });
    expect(await f.digest(f.base, analysisHead)).not.toBe(await f.digest());
  } finally { await f.cleanup(); }
});

test("unknown setup fails closed and actual toolchain changes invalidate equivalence", async () => {
  const f = await fixture();
  try {
    expect(await f.digest(f.base, f.head, null)).toBeNull();
    expect(await f.digest(f.base, f.head, {})).toBeNull();
    expect(await f.digest(f.base, f.head, { ...setup, tools: [{ name: "node", version: "25" }] })).not.toBe(await f.digest());
    const invalidHead = await f.commit({ ".github/slop-sheriff.yml": "model: not-a-model" });
    expect(await f.digest(f.base, invalidHead)).not.toBe(await f.digest());
  } finally { await f.cleanup(); }
});
