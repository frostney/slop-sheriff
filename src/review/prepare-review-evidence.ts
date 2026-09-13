import { prepareRequirementInventory, readRequirementSource } from "./requirements";
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeSandboxSession } from "eve/sandbox";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import { z } from "zod";
import type { ReviewConfig } from "../config/review-config";
import type { TrustedGitHubContext } from "../github/trusted-context";
import { prepareReviewWorkspace, type ReviewWorkspaceDependencies } from "../github/review-workspace";
import type { MemoryAvailability } from "../memory/client";
import { memoryPolicyHash } from "../memory/policy";
import {
  readCapabilityPreflight,
  runCapabilityPreflight,
} from "./capability-preflight";
import {
  assembleReviewEvidenceLedger,
  prepareCommonProbe,
  readReviewEvidenceLedger,
  reviewEvidenceLedgerPath,
  validatePreparedArtifactArchives,
  validateReviewEvidenceLedgerComponents,
  writeReviewEvidenceLedger,
  type ReviewEvidenceLedger,
  type ReviewEvidenceLedgerIdentity,
} from "./evidence-ledger";
import {
  readReviewEvidenceManifest,
  readReviewEvidencePatch,
  repositoryPathSchema,
  resetReviewEvidence,
  reviewEvidenceDirectory,
  reviewFileStatusSchema,
  reviewEvidenceManifestSchema,
  type ReviewEvidenceManifest,
  writeIncludedReviewEvidence,
  writeReviewEvidenceManifest,
} from "./evidence-bundle";
import type { PreparedGitHubEvidence } from "./github-evidence";
import { prepareReviewEnvironment } from "./environment-setup";
import { localWorkspaceReceiptPath, physicalWorkspaceReceipt } from "./physical-workspace";
import {
  commonHistorySchema,
  commonMemoryQuery,
  commonReviewWorkSchema,
  commonWorkRecord,
  prepareCommonMemory,
} from "./common-work";

export const reviewFileScopeSchema = z
  .array(
    z.object({
      path: repositoryPathSchema,
      status: reviewFileStatusSchema,
    }),
  )
  .superRefine((files, ctx) => {
    const paths = files.map((file) => file.path);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: "custom",
        message: "Trusted review file paths must be unique",
      });
    }
  });

export type ReviewFileScope = z.infer<typeof reviewFileScopeSchema>;

const preparedHistoryLimit = 200;
let patchEncoder: Tiktoken | undefined;

export function countPatchTokens(text: string): number {
  patchEncoder ??= new Tiktoken(o200kBase);
  // Repository text is ordinary data even when it spells a model delimiter.
  return patchEncoder.encode(text, [], []).length;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function attributeValue(output: string, attribute: string): string | null {
  const fields = output.split("\0");
  for (let index = 1; index < fields.length; index += 3) {
    if (fields[index] === attribute) return fields[index + 1] ?? null;
  }
  return null;
}

function isSet(value: string | null): boolean {
  return value === "set" || value === "true";
}

function matchesPreparedScope(
  manifest: ReviewEvidenceManifest,
  files: ReviewFileScope,
): boolean {
  return (
    manifest.entries.length === files.length &&
    manifest.entries.every(
      (entry, index) =>
        entry.path === files[index]?.path &&
        entry.status === files[index]?.status,
    )
  );
}

async function prepareCommonHistory(
  sandbox: RuntimeSandboxSession,
  identity: ReviewEvidenceLedgerIdentity,
  files: ReviewFileScope,
) {
  const paths = [...files.map((file) => file.path)].sort();
  const historyIdentity = {
    executionRevision: "review-common-work-v1",
    repositoryId: identity.repositoryId,
    baseSha: identity.baseSha,
    headSha: identity.headSha,
    patchFingerprint: identity.patchFingerprint,
    paths,
    limit: preparedHistoryLimit,
  };
  const command = paths.length === 0
    ? null
    : `cd /workspace && git --literal-pathspecs log --format=%H --max-count=${preparedHistoryLimit + 1} ${shellQuote(identity.baseSha)} -- ${paths.map(shellQuote).join(" ")}`;
  const result = command
    ? await sandbox.run({ command })
    : { exitCode: 0, stdout: "", stderr: "" };
  if (result.exitCode !== 0) {
    throw new Error("Could not prepare common repository history");
  }
  const observed = String(result.stdout)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (observed.some((sha) => !/^[a-f0-9]{40}$/.test(sha))) {
    throw new Error("Prepared repository history contained an invalid revision");
  }
  const shallow = paths.length === 0 ? null : await sandbox.run({
    command: "cd /workspace && git rev-parse --is-shallow-repository",
  });
  if (shallow && (shallow.exitCode !== 0 || !/^(true|false)$/.test(String(shallow.stdout).trim()))) {
    throw new Error("Could not determine repository history completeness");
  }
  const output = {
    baseSha: identity.baseSha,
    paths,
    commitShas: observed.slice(0, preparedHistoryLimit),
    truncated: observed.length > preparedHistoryLimit || String(shallow?.stdout).trim() === "true",
  };
  const record = commonWorkRecord({
    kind: "repository-history",
    identity: historyIdentity,
    output,
  });
  return {
    record,
    history: commonHistorySchema.parse({ workId: record.id, ...output }),
  };
}

async function preparedLedger(
  sandbox: RuntimeSandboxSession,
  identity: ReviewEvidenceLedgerIdentity,
  files: ReviewFileScope,
): Promise<ReviewEvidenceLedger | null> {
  const ledgerSource = await sandbox.readTextFile({
    path: reviewEvidenceLedgerPath(identity.patchFingerprint),
  });
  if (ledgerSource === null) return null;
  const ledger = await readReviewEvidenceLedger(sandbox, identity);
  if (!ledger.requirements) return null;
  for (const source of ledger.requirements) await readRequirementSource(sandbox, identity.patchFingerprint, ledger.requirements, source.id);
  const manifest = await readReviewEvidenceManifest(sandbox, identity);
  if (!matchesPreparedScope(manifest, files)) {
    throw new Error("Prepared evidence ledger does not match the exact file scope");
  }
  for (const entry of manifest.entries) {
    if (entry.kind === "included") {
      await readReviewEvidencePatch(sandbox, manifest, {
        path: entry.path,
        cursor: 0,
      });
    }
  }
  const capabilities = await readCapabilityPreflight(sandbox, identity);
  if (!capabilities.setup) return null; // Rebuild ledgers prepared before environment provisioning.
  validateReviewEvidenceLedgerComponents(ledger, {
    capabilities,
    manifest,
  });
  await validatePreparedArtifactArchives(sandbox, ledger);
  return ledger;
}

// Tools can be retried or invoked concurrently before the immutable ledger
// exists. Serialize the whole checkout/setup transaction on the shared sandbox.
const pendingPreparations = new Map<string | RuntimeSandboxSession, Promise<ReviewEvidenceLedger>>();

export function prepareReviewEvidence(
  ...args: Parameters<typeof prepareReviewEvidenceOnce>
): Promise<ReviewEvidenceLedger> {
  const sandbox = args[0];
  const key = sandbox.id || sandbox;
  const prior = pendingPreparations.get(key);
  const pending = (prior ? prior.catch(() => undefined) : Promise.resolve())
    .then(() => prepareReviewEvidenceOnce(...args));
  pendingPreparations.set(key, pending);
  void pending.finally(() => {
    if (pendingPreparations.get(key) === pending) pendingPreparations.delete(key);
  }).catch(() => undefined);
  return pending;
}

async function prepareReviewEvidenceOnce(
  sandbox: RuntimeSandboxSession,
  trusted: TrustedGitHubContext,
  inputFiles: unknown,
  input: {
    readonly collectGitHubEvidence: () => Promise<PreparedGitHubEvidence>;
    readonly collectMemory: (query: string) => Promise<MemoryAvailability>;
    readonly config: Pick<ReviewConfig, "embedding"> & Partial<Pick<ReviewConfig, "publicRoots" | "requirementPaths" | "lanes">>;
    readonly planKind: "full" | "delta";
    readonly workspaceDependencies?: ReviewWorkspaceDependencies;
  },
): Promise<ReviewEvidenceLedger> {
  if (!trusted.patchFingerprint) {
    throw new Error("Trusted review context is missing the patch fingerprint");
  }
  if (!trusted.repositoryDatabaseId) {
    throw new Error(
      "Trusted review context is missing the repository database id",
    );
  }
  const files = reviewFileScopeSchema.parse(inputFiles);
  const identity: ReviewEvidenceLedgerIdentity = {
    executionRevision: "review-evidence-v3",
    repositoryId: trusted.repositoryId,
    repositoryDatabaseId: trusted.repositoryDatabaseId,
    repository: trusted.repository,
    pullRequest: trusted.pullRequest,
    baseSha: trusted.baseSha,
    headSha: trusted.headSha,
    patchFingerprint: trusted.patchFingerprint,
    planKind: input.planKind,
  };
  const existing = await preparedLedger(sandbox, identity, files);
  const physicalReceipt = (ledger: ReviewEvidenceLedger) => physicalWorkspaceReceipt(sandbox.id, trusted, ledger);
  const provisionEnvironment = () => prepareReviewEnvironment(sandbox, identity, {
    paths: files.map((file) => file.path), publicRoots: input.config.publicRoots ?? [],
  });
  if (existing) {
    const receipt = await sandbox.readTextFile({ path: localWorkspaceReceiptPath });
    const checkout = receipt === physicalReceipt(existing)
      ? await sandbox.run({ command: "cd /workspace && git rev-parse --verify HEAD" }) : null;
    if (!checkout || checkout.exitCode !== 0 || String(checkout.stdout).trim() !== trusted.headSha) {
      // Restore physical prerequisites without regenerating immutable evidence or completed lanes.
      await prepareReviewWorkspace(trusted, sandbox, input.workspaceDependencies);
      await provisionEnvironment();
      await sandbox.writeTextFile({ path: localWorkspaceReceiptPath, content: physicalReceipt(existing) });
    }
    console.info(
      JSON.stringify({
        event: "known-good-review.common_work.reused",
        ledgerDigest: existing.digest,
        commonWorkIds: existing.commonWork.records.map((record) => record.id),
      }),
    );
    return existing;
  }

  const mergeBaseSha = await prepareReviewWorkspace(trusted, sandbox, input.workspaceDependencies);
  await resetReviewEvidence(sandbox, trusted.patchFingerprint);
  const indexPath = `/tmp/known-good-review-index-${randomUUID()}`;
  const base = shellQuote(trusted.baseSha);
  const diffBase = shellQuote(mergeBaseSha);
  const head = shellQuote(trusted.headSha);
  const entries: ReviewEvidenceManifest["entries"] = [];
  try {
    const prepared = await sandbox.run({
      command: `cd /workspace && GIT_INDEX_FILE=${shellQuote(indexPath)} git read-tree ${base}`,
    });
    if (prepared.exitCode !== 0) {
      throw new Error(
        "Could not prepare trusted-base attributes for review evidence",
      );
    }
    for (const file of files) {
      const path = shellQuote(file.path);
      const attributes = await sandbox.run({
        command: `cd /workspace && GIT_INDEX_FILE=${shellQuote(indexPath)} git check-attr -z --cached linguist-generated linguist-vendored binary diff -- ${path}`,
      });
      if (attributes.exitCode !== 0) {
        throw new Error(
          `Could not classify ${file.path} from trusted-base attributes`,
        );
      }
      const numstat = await sandbox.run({
        command: `cd /workspace && git --literal-pathspecs diff --numstat ${diffBase} ${head} -- ${path}`,
      });
      if (numstat.exitCode !== 0) {
        throw new Error(`Could not classify Git diff for ${file.path}`);
      }
      const [added = "0", deleted = "0"] = String(numstat.stdout).split(
        "\t",
        2,
      );
      const classification: Array<"generated" | "vendored" | "binary"> = [];
      if (
        isSet(attributeValue(String(attributes.stdout), "linguist-generated"))
      ) {
        classification.push("generated");
      }
      if (
        isSet(attributeValue(String(attributes.stdout), "linguist-vendored"))
      ) {
        classification.push("vendored");
      }
      if (
        added === "-" ||
        deleted === "-" ||
        isSet(attributeValue(String(attributes.stdout), "binary")) ||
        attributeValue(String(attributes.stdout), "diff") === "unset"
      ) {
        classification.push("binary");
      }
      const patch = await sandbox.run({
        command: `cd /workspace && git --literal-pathspecs diff --no-ext-diff --full-index ${diffBase} ${head} -- ${path}`,
      });
      if (patch.exitCode !== 0) {
        throw new Error(`Could not summarize classified patch ${file.path}`);
      }
      const text = String(patch.stdout);
      const patchTokens = countPatchTokens(text);
      entries.push(
        classification.length === 0
          ? await writeIncludedReviewEvidence(sandbox, {
              patchFingerprint: trusted.patchFingerprint,
              path: file.path,
              patch: text,
              patchTokens,
              status: file.status,
            })
          : {
              kind: "excluded",
              path: file.path,
              classification,
              status: file.status,
              addedLines: added === "-" ? 0 : Number.parseInt(added, 10),
              deletedLines: deleted === "-" ? 0 : Number.parseInt(deleted, 10),
              patchCharacters: text.length,
              patchTokens,
              patchSha256: createHash("sha256").update(text).digest("hex"),
            },
      );
    }
  } finally {
    await sandbox.run({ command: `rm -f -- ${shellQuote(indexPath)}` });
  }
  // Use the persisted schema shape for every digest and common-work identity.
  // Excluded entries are assembled above in a different property order.
  const manifest = reviewEvidenceManifestSchema.parse({
    schemaVersion: 1,
    baseSha: trusted.baseSha,
    headSha: trusted.headSha,
    patchFingerprint: trusted.patchFingerprint,
    entries,
  });
  await writeReviewEvidenceManifest(sandbox, manifest);
  const requirements = await prepareRequirementInventory(sandbox, {
    ...identity, paths: files.map((file) => file.path), config: input.config,
  });
  const setup = await provisionEnvironment();
  const capabilities = await runCapabilityPreflight(sandbox, identity, setup);
  if (capabilities.created) {
    console.info(
      JSON.stringify({
        event: "known-good-review.capability_preflight.completed",
        digest: capabilities.preflight.digest,
      }),
    );
  }
  const preparedGitHub = await input.collectGitHubEvidence();
  for (const artifact of preparedGitHub.evidence.artifacts.entries) {
    const archive = preparedGitHub.archives.get(artifact.id);
    if (!archive) {
      throw new Error(
        "Prepared artifact metadata is missing its validated archive",
      );
    }
    await sandbox.writeBinaryFile({
      path: `${reviewEvidenceDirectory(identity.patchFingerprint)}/${artifact.archiveFile}`,
      content: archive,
    });
  }
  const diffCheckCommand = `cd /workspace && git diff --check ${diffBase} ${head}`;
  const diffCheck = await sandbox.run({ command: diffCheckCommand });
  const probes = [
    prepareCommonProbe({
      id: "git-diff-check",
      command: "git diff --check <merge-base> <head>",
      exitCode: diffCheck.exitCode,
      stdout: String(diffCheck.stdout),
      stderr: String(diffCheck.stderr),
    }),
  ];
  const query = commonMemoryQuery(files);
  const [preparedHistory, memoryAvailability] = await Promise.all([
    prepareCommonHistory(sandbox, identity, files),
    input.collectMemory(query),
  ]);
  const preparedMemory = prepareCommonMemory({
    availability: memoryAvailability,
    config: input.config,
    identity,
    policyHash: memoryPolicyHash(),
    query,
  });
  const commonWork = commonReviewWorkSchema.parse({
    executionRevision: "review-common-work-v1",
    records: [
      commonWorkRecord({
        kind: "patch-manifest",
        identity: { identity, files },
        output: manifest,
      }),
      commonWorkRecord({
        kind: "capability-preflight",
        identity,
        output: capabilities.preflight,
      }),
      commonWorkRecord({
        kind: "github-evidence",
        identity: {
          repositoryDatabaseId: identity.repositoryDatabaseId,
          headSha: identity.headSha,
        },
        output: preparedGitHub.evidence,
      }),
      preparedHistory.record,
      preparedMemory.record,
      ...probes.map((probe) =>
        commonWorkRecord({
          kind: "common-probe",
          identity: { identity, id: probe.id, command: probe.command },
          output: probe,
        }),
      ),
    ],
    history: preparedHistory.history,
    memory: preparedMemory.memory,
  });
  const ledger = assembleReviewEvidenceLedger({
    capabilities: capabilities.preflight,
    commonWork,
    github: preparedGitHub.evidence,
    identity,
    manifest,
    probes,
    requirements,
  });
  await writeReviewEvidenceLedger(sandbox, ledger);
  await sandbox.writeTextFile({ path: localWorkspaceReceiptPath, content: physicalReceipt(ledger) });
  console.info(
    JSON.stringify({
      event: "known-good-review.common_work.completed",
      digest: ledger.digest,
      commonWorkIds: ledger.commonWork.records.map((record) => record.id),
      gaps: ledger.gaps.map((gap) => gap.id),
    }),
  );
  return ledger;
}
