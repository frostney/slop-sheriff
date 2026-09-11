import { authenticatedEvidenceSandbox } from "../src/review/authenticated-evidence";
import { createHash } from "node:crypto";
import { describe, expect, spyOn, test } from "bun:test";
import { reviewRouteState } from "../agent/lib/review-route";
import type { RuntimeSandboxSession } from "eve/sandbox";
import {
  GitHubEvidenceError,
  prepareExactHeadGitHubEvidence,
} from "../src/review/github-evidence";
import {
  capabilityCommandNames,
  capabilityPreflightSchema,
  runCapabilityPreflight,
} from "../src/review/capability-preflight";
import {
  assembleReviewEvidenceLedger,
  readReviewEvidenceLedger,
  reviewEvidenceLedgerPath,
  validatePreparedArtifactArchives,
  writeReviewEvidenceLedger,
} from "../src/review/evidence-ledger";
import { writeReviewEvidenceManifest } from "../src/review/evidence-bundle";
import { countPatchTokens, prepareReviewEvidence } from "../src/review/prepare-review-evidence";
import readReviewEvidenceTool from "../agent/tools/read_review_evidence";
import { withTrustedReviewContext } from "../src/github/trusted-context";
import { parseReviewConfig } from "../src/config/review-config";
import { commonWorkFixture } from "./common-work-fixture";
import { writeLaneCheckpoint } from "../src/review/lane-checkpoint";

const headSha = "2".repeat(40);
const repositoryDatabaseId = 41;
const archive = new TextEncoder().encode("sanitized generated output");
const archiveDigest = `sha256:${createHash("sha256").update(archive).digest("hex")}`;

function checkRun(head = headSha) {
  return {
    id: 101,
    name: "docs",
    head_sha: head,
    status: "completed",
    conclusion: "success",
    details_url: "https://github.com/frostney/repo/actions/runs/201",
    external_id: "docs-201",
    app: { slug: "github-actions" },
  };
}

function workflowRun(head = headSha) {
  return {
    id: 201,
    name: "PR",
    head_sha: head,
    status: "completed",
    conclusion: "success",
    event: "pull_request",
    run_attempt: 1,
    repository: { id: repositoryDatabaseId },
    head_repository: { id: repositoryDatabaseId },
  };
}

function artifact(digest = archiveDigest) {
  return {
    id: 301,
    name: "website-output",
    size_in_bytes: archive.byteLength,
    expired: false,
    digest,
    created_at: "2026-08-24T12:00:00.000Z",
    expires_at: "2026-11-22T12:00:00.000Z",
    workflow_run: {
      id: 201,
      repository_id: repositoryDatabaseId,
      head_repository_id: repositoryDatabaseId,
      head_sha: headSha,
    },
  };
}

function replay(input?: {
  readonly artifactDigest?: string;
  readonly checkHead?: string;
  readonly includeArtifact?: boolean;
  readonly workflowHead?: string;
}) {
  const run = workflowRun(input?.workflowHead);
  const includeArtifact = input?.includeArtifact ?? true;
  return prepareExactHeadGitHubEvidence({
    artifactsByRun: new Map([
      [
        run.id,
        includeArtifact
          ? [
              {
                archive,
                metadata: artifact(input?.artifactDigest),
              },
            ]
          : [],
      ],
    ]),
    checkRuns: [checkRun(input?.checkHead)],
    headSha,
    observedAt: "2026-08-24T12:01:00.000Z",
    repositoryDatabaseId,
    workflowRuns: [run],
  });
}

describe("exact-head evidence replay", () => {
  test("counts arbitrary repository text without interpreting model delimiters", () => {
    expect(countPatchTokens("hello world")).toBe(2);
    for (const text of ["<|endoftext|>", "<|fim_prefix|>", "日本語 🚀", ""]) {
      const count = countPatchTokens(text);
      if (text.length === 0) expect(count).toBe(0);
      else expect(count).toBeGreaterThan(0);
      expect(countPatchTokens(text)).toBe(count);
    }
  });

  test("accepts a digest-validated artifact from the exact workflow head", () => {
    const prepared = replay();

    expect(prepared.evidence.artifacts.status).toBe("available");
    expect(prepared.evidence.artifacts.entries).toHaveLength(1);
    expect(prepared.evidence.artifacts.entries[0]).toMatchObject({
      id: 301,
      digest: archiveDigest,
      archiveFile: "artifact-301.zip",
      workflowRun: {
        id: 201,
        headSha,
        repositoryDatabaseId,
      },
    });
    expect(prepared.archives.get(301)).toEqual(archive);
    expect(prepared.evidence.gaps).toEqual([]);
  });

  test("binds the root digest and artifact bytes to the complete review identity", async () => {
    const prepared = replay();
    const identity = {
      executionRevision: "review-evidence-v3" as const,
      repositoryId: "R_test",
      repositoryDatabaseId,
      repository: "frostney/pascal-mcp-sdk",
      pullRequest: 61,
      baseSha: "1".repeat(40),
      headSha,
      patchFingerprint: "3".repeat(64),
      planKind: "delta" as const,
    };
    const ledger = assembleReviewEvidenceLedger({
      capabilities: capabilityPreflightSchema.parse({
        schemaVersion: 1,
        baseSha: identity.baseSha,
        headSha,
        patchFingerprint: identity.patchFingerprint,
        network: "github-only",
        commands: [],
        repositoryMarkers: [],
        digest: "7".repeat(64),
      }),
      commonWork: commonWorkFixture(identity),
      github: prepared.evidence,
      identity,
      manifest: {
        schemaVersion: 1,
        baseSha: identity.baseSha,
        headSha,
        patchFingerprint: identity.patchFingerprint,
        entries: [],
      },
      probes: [],
    });
    const files = new Map<string, string>();
    const binaries = new Map<string, Uint8Array>([
      [
        `/tmp/known-good-review/evidence/${identity.patchFingerprint}/artifact-301.zip`,
        archive,
      ],
    ]);
    const sandbox = {
      async readTextFile({ path }: { readonly path: string }) {
        return files.get(path) ?? null;
      },
      async writeTextFile({
        content,
        path,
      }: {
        readonly content: string;
        readonly path: string;
      }) {
        files.set(path, content);
      },
      async readBinaryFile({ path }: { readonly path: string }) {
        return binaries.get(path) ?? null;
      },
    };
    await writeReviewEvidenceLedger(sandbox, ledger);

    expect((await readReviewEvidenceLedger(sandbox, identity)).digest).toBe(
      ledger.digest,
    );
    await validatePreparedArtifactArchives(sandbox, ledger);
    await expect(
      readReviewEvidenceLedger(sandbox, {
        ...identity,
        repositoryDatabaseId: 99,
      }),
    ).rejects.toThrow("does not match");
    binaries.set(
      `/tmp/known-good-review/evidence/${identity.patchFingerprint}/artifact-301.zip`,
      new TextEncoder().encode("changed"),
    );
    await expect(
      validatePreparedArtifactArchives(sandbox, ledger),
    ).rejects.toThrow("integrity validation");
  });

  test("reuses one complete ledger without rerunning application preparation", async () => {
    const oldKey = process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY;
    const key = "ab".repeat(32);
    process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY = key;
    const route = spyOn(reviewRouteState, "get").mockReturnValue({ role: "lane", axis: "engineering-quality", attempt: 0 });
    try {
    const identity = {
      executionRevision: "review-evidence-v3" as const,
      repositoryId: "R_test",
      repositoryDatabaseId,
      repository: "frostney/pascal-mcp-sdk",
      pullRequest: 61,
      baseSha: "1".repeat(40),
      headSha,
      patchFingerprint: "3".repeat(64),
      planKind: "delta" as const,
    };
    const files = new Map<string, string>();
    const commands: string[] = [];
    const reads: string[] = [];
    const rawRuntime = {
      async removePath() {},
      async readTextFile({ path }: { readonly path: string }) {
        reads.push(path);
        return files.get(path) ?? null;
      },
      async readBinaryFile() {
        return null;
      },
      async run({ command }: { readonly command: string }) {
        commands.push(command);
        return {
          exitCode: 0,
          stderr: "",
          stdout: capabilityCommandNames
            .map((name) => `command\t${name}\t${name === "git" ? "1" : "0"}`)
            .join("\n"),
        };
      },
      async writeTextFile({
        content,
        path,
      }: {
        readonly content: string;
        readonly path: string;
      }) {
        files.set(path, content);
      },
    };
    const runtime = authenticatedEvidenceSandbox(rawRuntime, "review-root", key);
    const manifest = {
      schemaVersion: 1 as const,
      baseSha: identity.baseSha,
      headSha,
      patchFingerprint: identity.patchFingerprint,
      entries: [],
    };
    const capabilities = await runCapabilityPreflight(runtime, identity, {
      revision: "review-environment-v1", headSha: identity.headSha,
      inputsDigest: "a".repeat(64), tools: [], completedSteps: [],
    });
    await writeReviewEvidenceManifest(runtime, manifest);
    const github = prepareExactHeadGitHubEvidence({
      artifactsByRun: new Map(),
      checkRuns: [],
      headSha,
      observedAt: "2026-08-24T12:01:00.000Z",
      repositoryDatabaseId,
      workflowRuns: [],
    });
    const ledger = assembleReviewEvidenceLedger({
      capabilities: capabilities.preflight,
      commonWork: commonWorkFixture(identity),
      github: github.evidence,
      identity,
      manifest,
      probes: [],
    });
    await writeReviewEvidenceLedger(runtime, ledger);
    commands.length = 0;
    let collectionCalls = 0;
    const trusted = {
      installationId: 1,
      owner: "frostney",
      repo: "pascal-mcp-sdk",
      pullRequest: identity.pullRequest,
      repository: identity.repository,
      repositoryCreatedAt: 0,
      repositoryDatabaseId,
      repositoryId: identity.repositoryId,
      baseSha: identity.baseSha,
      headSha,
      patchFingerprint: identity.patchFingerprint,
    };
    const preparation = {
      config: parseReviewConfig(null),
      planKind: identity.planKind,
      async collectMemory() {
        collectionCalls += 1;
        return {
          kind: "unavailable" as const,
          reason: "Repository memory is not configured.",
        };
      },
      async collectGitHubEvidence() {
        collectionCalls += 1;
        return github;
      },
    };

    const reused = await prepareReviewEvidence(
      runtime as unknown as RuntimeSandboxSession,
      trusted,
      [],
      preparation,
    );

    expect(reused).toEqual(ledger);
    expect(collectionCalls).toBe(0);
    expect(commands).toEqual([]);

    const execute = readReviewEvidenceTool.execute;
    if (!execute) throw new Error("Evidence tool must have an executor");
    const auth = withTrustedReviewContext({
      principalId: "test",
      principalType: "user",
      authenticator: "github",
      attributes: {
        installation_id: "1",
        repository: trusted.repository,
        pull_request_number: String(trusted.pullRequest),
      },
    }, {
      ...trusted,
      configSource: "",
      event: "synchronize",
      plan: JSON.stringify({ kind: "delta" }),
      reviewFiles: [],
    });
    // Only session identity, auth, and sandbox access participate in this tool.
    const ctx = {
      session: { id: "lane-1", parent: { rootSessionId: "review-root" }, auth: { current: auth } },
      getSandbox: async () => rawRuntime,
    } as unknown as Parameters<typeof execute>[1];
    reads.length = 0;
    const packet = await execute({
      operation: "packet", axis: "engineering-quality", path: null, cursor: null,
    }, ctx);
    expect(packet).toMatchObject({ operation: "packet", ledgerDigest: ledger.digest });
    expect(reads.filter((path) => path.endsWith("/ledger.json"))).toHaveLength(1);
    expect(reads.filter((path) => path.endsWith("/capabilities.json"))).toHaveLength(1);

    await writeLaneCheckpoint(runtime, {
      baseSha: identity.baseSha, headSha: identity.headSha,
      patchFingerprint: identity.patchFingerprint, evidenceDigest: ledger.digest,
    }, "engineering-quality", {
      status: "in-progress", reviewedEntries: [], remainingEntries: [], observations: [], nextSteps: ["finish review"],
      limitations: [], completedReport: null,
    }, 0);
    reads.length = 0;
    await execute({ operation: "packet", axis: "engineering-quality", path: null, cursor: null }, {
      ...ctx, session: { ...ctx.session, id: "lane-2" },
    });
    expect(reads.some((path) => path.endsWith("engineering-quality-revision-1.json"))).toBe(true);

    const ledgerPath = reviewEvidenceLedgerPath(identity.patchFingerprint);
    await runtime.writeTextFile({ path: ledgerPath, content: JSON.stringify({ ...ledger, identity: { ...identity, executionRevision: "review-evidence-v2" } }) });
    await expect(prepareReviewEvidence(
      runtime as unknown as RuntimeSandboxSession, trusted, [], preparation,
    )).rejects.toThrow("review-evidence-v3");
    await runtime.writeTextFile({
      path: ledgerPath,
      content: JSON.stringify({ ...ledger, digest: "9".repeat(64) }),
    });
    await expect(
      prepareReviewEvidence(
        runtime as unknown as RuntimeSandboxSession,
        trusted,
        [],
        preparation,
      ),
    ).rejects.toThrow("integrity validation");
    expect(collectionCalls).toBe(0);
    await expect(execute({
      operation: "packet", axis: "engineering-quality", path: null, cursor: null,
    }, ctx)).rejects.toThrow("integrity validation");
    } finally {
      route.mockRestore();
      if (oldKey === undefined) delete process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY;
      else process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY = oldKey;
    }
  });

  test("keeps absent artifacts as availability metadata without a routine gap", () => {
    const prepared = replay({ includeArtifact: false });

    expect(prepared.evidence.artifacts).toMatchObject({
      status: "missing",
      entries: [],
      disposition: {
        id: "exact-head-artifacts-missing",
        owner: "repository",
        disposition: "check-remedy",
      },
    });
    expect(prepared.evidence.gaps.map((gap) => gap.id)).toEqual([]);
  });

  test("rejects stale Check and workflow evidence", () => {
    expect(() => replay({ checkHead: "4".repeat(40) })).toThrow(
      new GitHubEvidenceError("stale-check-head"),
    );
    expect(() => replay({ workflowHead: "5".repeat(40) })).toThrow(
      new GitHubEvidenceError("stale-workflow-head"),
    );
  });

  test("rejects an artifact whose bytes do not match GitHub provenance", () => {
    expect(() => replay({ artifactDigest: `sha256:${"6".repeat(64)}` })).toThrow(
      new GitHubEvidenceError("artifact-digest-mismatch"),
    );
  });
});
