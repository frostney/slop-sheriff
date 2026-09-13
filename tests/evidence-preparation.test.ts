import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeSandboxSession } from "eve/sandbox";
import { prepareReviewEvidence } from "../src/review/prepare-review-evidence";
import { readReviewEvidenceManifest, readReviewEvidencePatch } from "../src/review/evidence-bundle";
import { prepareExactHeadGitHubEvidence } from "../src/review/github-evidence";
import { parseReviewConfig } from "../src/config/review-config";
import { readLaneReviewEvidencePacket } from "../src/review/lane-evidence";
import { reviewAxes } from "../src/review/axes";
import { digestCommonWorkValue } from "../src/review/common-work";
import { localWorkspaceReceiptPath } from "../src/review/physical-workspace";

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code) throw new Error(`Git fixture failed: ${stderr}`);
  return stdout.trim();
}

test("prepares real Git patches for literal paths and trusted-base attributes", async () => {
  const root = await mkdtemp(join(tmpdir(), "kgr-evidence-"));
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  const acquisition = join(root, "acquisition");
  let tokenRequests = 0;
  let environmentInventories = 0;
  try {
    await mkdir(source);
    await mkdir(workspace);
    await mkdir(acquisition);
    await git(source, "init", "--quiet");
    await git(source, "config", "user.email", "fixture@example.test");
    await git(source, "config", "user.name", "Fixture");
    await mkdir(join(source, "src"));
    const paths = ["src/[id].ts", "src/i.ts", "src/generated.ts", "src/odd: linguist-generated: true.ts", "src/banner.png"];
    for (const path of paths) await writeFile(join(source, path), "old\n");
    await writeFile(join(source, "src/banner.png"), Buffer.from([0, 1, 2]));
    await writeFile(join(source, "src/unrelated-whitespace.ts"), "unchanged   \n");
    await writeFile(join(source, ".gitattributes"), 'src/generated.ts linguist-generated\n"src/odd: linguist-generated: true.ts" linguist-generated\n');
    await git(source, "add", ".");
    await git(source, "commit", "--quiet", "-m", "base");
    const mergeBaseSha = await git(source, "rev-parse", "HEAD");
    for (const [index, path] of paths.entries()) {
      await writeFile(join(source, path), `changed-${index}\n`);
    }
    await writeFile(join(source, "src/banner.png"), Buffer.from([0, 3, 4]));
    await writeFile(join(source, ".gitattributes"), "");
    await git(source, "add", ".");
    await git(source, "commit", "--quiet", "-m", "head");
    const headSha = await git(source, "rev-parse", "HEAD");
    await git(source, "update-ref", "refs/pull/61/head", headSha);
    await git(source, "checkout", "--detach", mergeBaseSha);
    await writeFile(join(source, paths[0]!), "base-only\n");
    await writeFile(join(source, "src/unrelated-whitespace.ts"), "unchanged\n");
    await git(source, "add", ".");
    await git(source, "commit", "--quiet", "-m", "base advances independently");
    const baseSha = await git(source, "rev-parse", "HEAD");
    const files = new Map<string, string>();
    const runtime = {
      async readTextFile({ path }: { path: string }) { return files.get(path) ?? null; },
      async writeTextFile({ path, content }: { path: string; content: string }) { files.set(path, content); },
      async removePath({ path }: { path: string }) {
        if (path === ".git") await rm(join(workspace, ".git"), { force: true, recursive: true });
        else for (const key of files.keys()) if (key.startsWith(path)) files.delete(key);
      },
      async readBinaryFile() { return null; },
      async writeBinaryFile({ path, content }: { path: string; content: Buffer }) { await writeFile(path.replace("/tmp/review-repository.tar", join(root, "review-repository.tar")), content); },
      async setNetworkPolicy() {},
      async run({ command }: { command: string }) {
        if (command === "cd /workspace && git ls-files -z") environmentInventories += 1;
        const localCommand = (process.platform === "darwin" ? command.replace("stat -c '%s'", "stat -f '%z'") : command).replaceAll("/tmp/review-repository.tar", join(root, "review-repository.tar")).replaceAll("/workspace", workspace)
          .replaceAll("https://github.com/acme/widget.git", source);
        const child = Bun.spawn(["sh", "-c", localCommand], {
          cwd: workspace, stdout: "pipe", stderr: "pipe",
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        return { stdout, stderr, exitCode };
      },
    };
    const trusted = {
      installationId: 1, owner: "acme", repo: "widget", repository: "acme/widget",
      repositoryId: "R_widget", repositoryDatabaseId: 1, repositoryCreatedAt: 0,
      pullRequest: 61, baseSha, headSha, patchFingerprint: "a".repeat(64),
    };
    const preparing = prepareReviewEvidence(
      runtime as unknown as RuntimeSandboxSession, trusted,
      paths.map((path) => ({ path, status: "modified" })), {
        planKind: "full", config: parseReviewConfig(null),
        workspaceDependencies: {
          createAcquisitionSandbox: async () => ({ session: {
            ...runtime,
            run: ({ command }: { command: string }) => runtime.run({ command: command.replaceAll("/workspace", acquisition).replaceAll("/tmp/review-repository.tar", join(root, "acquired-repository.tar")) }),
            readBinaryFile: async ({ path }: { path: string }) => readFile(path.replaceAll("/tmp/review-repository.tar", join(root, "acquired-repository.tar"))),
          } as unknown as RuntimeSandboxSession, delete: async () => {} }),
          getMergeBase: async (context) => git(source, "merge-base", context.baseSha, context.headSha),
          getInstallationToken: async () => { tokenRequests += 1; return "fixture-token"; },
        },
        collectMemory: async () => ({ kind: "unavailable", reason: "Offline fixture" }),
        collectGitHubEvidence: async () => prepareExactHeadGitHubEvidence({
          artifactsByRun: new Map(), checkRuns: [], workflowRuns: [],
          repositoryDatabaseId: 1, headSha, observedAt: "2026-09-04T00:00:00.000Z",
        }),
      },
    );
    const concurrent = prepareReviewEvidence(runtime as unknown as RuntimeSandboxSession, trusted,
      paths.map((path) => ({ path, status: "modified" })), {
        planKind: "full", config: parseReviewConfig(null),
        collectMemory: async () => { throw new Error("Concurrent preparation recollected memory"); },
        collectGitHubEvidence: async () => { throw new Error("Concurrent preparation recollected GitHub evidence"); },
        workspaceDependencies: {
          createAcquisitionSandbox: async () => ({ session: {
            ...runtime,
            run: ({ command }: { command: string }) => runtime.run({ command: command.replaceAll("/workspace", acquisition).replaceAll("/tmp/review-repository.tar", join(root, "acquired-repository.tar")) }),
            readBinaryFile: async ({ path }: { path: string }) => readFile(path.replaceAll("/tmp/review-repository.tar", join(root, "acquired-repository.tar"))),
          } as unknown as RuntimeSandboxSession, delete: async () => {} }),
          getMergeBase: async () => { throw new Error("Concurrent preparation fetched checkout"); },
          getInstallationToken: async () => { throw new Error("Concurrent preparation requested token"); },
        },
      });
    const [ledger, concurrentLedger] = await Promise.all([preparing, concurrent]);
    expect(concurrentLedger).toEqual(ledger);
    expect(ledger.components.capabilityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenRequests).toBe(1);
    const manifest = await readReviewEvidenceManifest(runtime, trusted);
    expect(manifest.entries.find((entry) => entry.path === "src/generated.ts"))
      .toMatchObject({ kind: "excluded", classification: ["generated"] });
    expect(manifest.entries.find((entry) => entry.path === paths[3]))
      .toMatchObject({ kind: "excluded", classification: ["generated"] });
    expect(manifest.entries.find((entry) => entry.path === "src/banner.png"))
      .toMatchObject({ kind: "excluded", classification: ["binary"] });
    const patch = await readReviewEvidencePatch(runtime, manifest, { path: paths[0]!, cursor: 0 });
    expect(patch.content).toContain("+changed-0");
    expect(patch.content).not.toContain("changed-1");
    expect(patch.content).toContain("-old");
    expect(patch.content).not.toContain("base-only");
    expect(ledger.commonWork.history.paths).toEqual([...paths].sort());
    expect(ledger.commonWork.history.truncated).toBe(true);
    expect(ledger.probes.find((probe) => probe.id === "git-diff-check")?.outcome).toBe("passed");
    expect(ledger.commonWork.records.find((record) => record.kind === "patch-manifest")?.outputDigest)
      .toBe(digestCommonWorkValue(manifest));
    for (const axis of reviewAxes) {
      const packet = await readLaneReviewEvidencePacket(
        runtime, ledger.identity, manifest, axis, `lane-${axis}`,
      );
      expect(packet.totalEntries).toBe(paths.length);
      expect(packet.ledgerDigest).toBe(ledger.digest);
    }
    // Reusing the prepared snapshot must not fetch, probe, or regenerate it.
    const unexpectedCollection = async (): Promise<never> => { throw new Error("Prepared evidence was recollected"); };
    expect(await prepareReviewEvidence(runtime as unknown as RuntimeSandboxSession, trusted,
      paths.map((path) => ({ path, status: "modified" })), {
        planKind: "full", config: parseReviewConfig(null),
        collectMemory: unexpectedCollection, collectGitHubEvidence: unexpectedCollection,
        workspaceDependencies: {
          createAcquisitionSandbox: async () => ({ session: {
            ...runtime,
            run: ({ command }: { command: string }) => runtime.run({ command: command.replaceAll("/workspace", acquisition).replaceAll("/tmp/review-repository.tar", join(root, "acquired-repository.tar")) }),
            readBinaryFile: async ({ path }: { path: string }) => readFile(path.replaceAll("/tmp/review-repository.tar", join(root, "acquired-repository.tar"))),
          } as unknown as RuntimeSandboxSession, delete: async () => {} }), getMergeBase: unexpectedCollection, getInstallationToken: unexpectedCollection },
      })).toEqual(ledger);
    expect(environmentInventories).toBe(1);
    // Keep the durable evidence, lose the VM's checkout and its local-only receipt.
    const savedEvidence = new Map([...files].filter(([path]) => path !== localWorkspaceReceiptPath));
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace);
    await rm(acquisition, { recursive: true, force: true });
    await mkdir(acquisition);
    files.delete(localWorkspaceReceiptPath);
    const restoredRuntime = { ...runtime, id: "replacement-vm" } as unknown as RuntimeSandboxSession;
    const restorationInput = {
      planKind: "full" as const, config: parseReviewConfig(null),
      collectMemory: unexpectedCollection, collectGitHubEvidence: unexpectedCollection,
      workspaceDependencies: {
        createAcquisitionSandbox: async () => ({ session: {
          ...runtime,
          run: ({ command }: { command: string }) => runtime.run({ command: command.replaceAll("/workspace", acquisition).replaceAll("/tmp/review-repository.tar", join(root, "acquired-repository.tar")) }),
          readBinaryFile: async ({ path }: { path: string }) => readFile(path.replaceAll("/tmp/review-repository.tar", join(root, "acquired-repository.tar"))),
        } as unknown as RuntimeSandboxSession, delete: async () => {} }),
        getMergeBase: async () => mergeBaseSha,
        getInstallationToken: async () => { tokenRequests += 1; return "fixture-token"; },
      },
    };
    expect(await prepareReviewEvidence(restoredRuntime, trusted,
      paths.map(path => ({ path, status: "modified" })), restorationInput)).toEqual(ledger);
    expect(await git(workspace, "rev-parse", "HEAD")).toBe(headSha);
    expect(await readFile(join(workspace, paths[0]!), "utf8")).toBe("changed-0\n");
    expect(environmentInventories).toBe(2);
    expect(tokenRequests).toBe(2);
    expect(new Map([...files].filter(([path]) => path !== localWorkspaceReceiptPath))).toEqual(savedEvidence);
    expect(await prepareReviewEvidence(restoredRuntime, trusted,
      paths.map(path => ({ path, status: "modified" })), restorationInput)).toEqual(ledger);
    expect(environmentInventories).toBe(2);
    expect(tokenRequests).toBe(2);
    const changedManifest = structuredClone(manifest);
    changedManifest.entries[0]!.patchTokens += 1;
    await expect(readLaneReviewEvidencePacket(runtime, ledger.identity, changedManifest,
      "engineering-quality", "tampered-lane")).rejects.toThrow("Prepared evidence components failed ledger validation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
