import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { vercel } from "eve/sandbox/vercel";
import type { SandboxSession } from "eve/sandbox";
import type { ReviewConfig } from "../config/review-config";
import { authenticatedEvidenceSandbox } from "../review/authenticated-evidence";
import {
  reviewEvidenceManifestSchema,
  writeIncludedReviewEvidence,
  type ReviewEvidenceManifest,
} from "../review/evidence-bundle";
import { countPatchTokens } from "../review/prepare-review-evidence";
import { prepareReviewEnvironment } from "../review/environment-setup";
import {
  prepareRequirementInventory,
  type RequirementSource,
} from "../review/requirements";
import {
  selectReviewAxes,
  type ReviewAxisDecision,
} from "../review/axis-selection";
import type { PatchFile } from "../review/effective-patch";
import type { TrustedGitHubContext } from "../github/trusted-context";
import type { ReviewWorkSandbox } from "../review/prepare-review-work";
import { workHash } from "../review/work-plan";
import type { QualityEvaluationInput } from "./review-quality";
import {
  prepareReviewWork,
  preparedReviewWorkPacketSchema,
} from "../review/prepare-review-work";
import { reviewWorkContext } from "../review/work-execution";
import {
  reviewChildInstructions,
  reviewAdjudicationInstructions,
} from "../review/policy";
import { z } from "zod";
import {
  qualityCommonPrefix,
  qualityWorkToolSchemas,
} from "./quality-tool-contracts";
import {
  orchestrateReview,
  type ReviewChildDispatch,
} from "../review/orchestration";
import { reviewAdjudicationDraftSchema } from "../review/adjudication";
import { chainForRoute, reasoningForRoute } from "../models/routing";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export interface QualityWorkspace {
  sandbox: ReviewWorkSandbox;
  trusted: TrustedGitHubContext;
  manifest: ReviewEvidenceManifest;
  requirements: RequirementSource[];
  decisions: ReviewAxisDecision[];
  changedFiles: Record<string, unknown>[];
  setup: unknown;
  close(): Promise<void>;
}

/** Export only selected commits and ancestors. Local branches and future fixes are never uploaded. */
export async function frozenQualityBundle(
  repositoryPath: string,
  input: QualityEvaluationInput,
): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), "sheriff-quality-export-"));
  const bare = join(root, "source.git");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    git("init", "--bare", bare);
    git(
      "-C",
      bare,
      "fetch",
      "--no-tags",
      resolve(repositoryPath),
      `${input.baseSha}:refs/heads/evaluation-base`,
      `${input.headSha}:refs/heads/evaluation-head`,
    );
    git("-C", bare, "bundle", "create", join(root, "review.bundle"), "--all");
    return await readFile(join(root, "review.bundle"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function inventoryQualityWorkspace(
  input: QualityEvaluationInput,
  config: ReviewConfig,
  sandbox: ReviewWorkSandbox & {
    removePath(options: { path: string }): Promise<void>;
  },
  setup: unknown,
  close: () => Promise<void>,
): Promise<QualityWorkspace> {
  const [owner, repo] = input.repository.split("/");
  if (!owner || !repo) throw new Error("Invalid corpus repository");
  const run = async (command: string) => {
    const result = await sandbox.run({
      command: `cd /workspace && ${command}`,
    });
    if (result.exitCode !== 0)
      throw new Error(
        `Frozen corpus inventory failed: ${String(result.stderr)}`,
      );
    return String(result.stdout);
  };
  if ((await run("git rev-parse HEAD")).trim() !== input.headSha)
    throw new Error("Evaluation workspace is not at the frozen head");
  const mergeBase = (
    await run(`git merge-base ${input.baseSha} ${input.headSha}`)
  ).trim();
  const patchFingerprint = workHash([
    input.repository,
    input.pullRequest,
    input.baseSha,
    input.headSha,
  ]);
  const trusted: TrustedGitHubContext = {
    installationId: 1,
    owner,
    repo,
    repository: input.repository,
    repositoryId: `quality:${input.repository}`,
    repositoryDatabaseId: 1,
    repositoryCreatedAt: 0,
    pullRequest: input.pullRequest,
    baseSha: input.baseSha,
    headSha: input.headSha,
    patchFingerprint,
    deliveryId: `quality-${randomUUID()}`,
  };
  const fields = (
    await run(
      `git diff --no-renames --name-status -z ${mergeBase} ${input.headSha}`,
    )
  ).split("\0");
  const entries: ReviewEvidenceManifest["entries"] = [],
    patchFiles: PatchFile[] = [],
    changedFiles: Record<string, unknown>[] = [];
  for (let index = 0; index < fields.length - 1; index += 2) {
    const code = fields[index]!,
      path = fields[index + 1]!;
    const status =
      code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    const patch = await run(
      `git --literal-pathspecs diff --no-ext-diff --no-textconv --full-index ${mergeBase} ${input.headSha} -- ${quote(path)}`,
    );
    const patchStart = patch.indexOf("@@"),
      hunks = patchStart < 0 ? null : patch.slice(patchStart);
    const counts = (
      await run(
        `git --literal-pathspecs diff --numstat ${mergeBase} ${input.headSha} -- ${quote(path)}`,
      )
    ).split("\t");
    const additions = Number.parseInt(counts[0] ?? "0", 10),
      deletions = Number.parseInt(counts[1] ?? "0", 10);
    const blob = (
      await run(
        `git rev-parse ${quote(`${status === "deleted" ? mergeBase : input.headSha}:${path}`)}`,
      )
    ).trim();
    patchFiles.push({
      path,
      status,
      blobSha: blob,
      patch: hunks,
      ...(Number.isFinite(additions) && Number.isFinite(deletions)
        ? { additions, deletions }
        : {}),
    });
    entries.push(
      await writeIncludedReviewEvidence(sandbox, {
        patchFingerprint,
        path,
        status,
        patch,
        patchTokens: countPatchTokens(patch),
      }),
    );
    changedFiles.push({
      filename: path,
      status: status === "deleted" ? "removed" : status,
      sha: blob,
      patch: hunks,
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    });
  }
  const manifest = reviewEvidenceManifestSchema.parse({
    schemaVersion: 1,
    baseSha: input.baseSha,
    headSha: input.headSha,
    patchFingerprint,
    entries,
  });
  const requirements = await prepareRequirementInventory(sandbox, {
    ...trusted,
    patchFingerprint,
    paths: patchFiles.map((file) => file.path),
    config,
  });
  return {
    sandbox,
    trusted,
    manifest,
    requirements,
    decisions: selectReviewAxes(
      patchFiles,
      config.publicRoots ?? [],
      config.lanes ?? [],
    ),
    changedFiles,
    setup,
    close,
  };
}

/** Explicit paid runs use the same native Eve/Vercel VM backend as production. */
export async function createVercelQualityWorkspace(
  repositoryPath: string,
  input: QualityEvaluationInput,
  config: ReviewConfig,
  secret: string,
): Promise<QualityWorkspace> {
  const bundle = await frozenQualityBundle(repositoryPath, input);
  const acquired = await vercel({
    networkPolicy: "deny-all",
    resources: { vcpus: 2 },
  }).create({
    templateKey: null,
    sessionKey: `quality-${randomUUID()}`,
    runtimeContext: { appRoot: process.cwd() },
  });
  const sandbox = authenticatedEvidenceSandbox(
    acquired.session,
    `quality:${input.caseId}:${input.headSha}`,
    secret,
  );
  try {
    await sandbox.writeBinaryFile({
      path: "/tmp/review-quality.bundle",
      content: bundle,
    });
    const checked = await sandbox.run({
      command: `mkdir -p /workspace && cd /workspace && git init --quiet && git fetch --no-tags /tmp/review-quality.bundle refs/heads/evaluation-base:refs/heads/evaluation-base refs/heads/evaluation-head:refs/heads/evaluation-head && git checkout --detach ${input.headSha} && rm /tmp/review-quality.bundle`,
    });
    if (checked.exitCode !== 0)
      throw new Error("Could not materialize the frozen evaluation repository");
    const workspace = await inventoryQualityWorkspace(
      input,
      config,
      sandbox,
      null,
      () => acquired.delete(),
    );
    workspace.setup = await prepareReviewEnvironment(
      sandbox as SandboxSession,
      workspace.trusted as TrustedGitHubContext & { patchFingerprint: string },
      {
        paths: workspace.manifest.entries.map((entry) => entry.path),
        publicRoots: config.publicRoots ?? [],
      },
    );
    return workspace;
  } catch (error) {
    await acquired.delete();
    throw error;
  }
}

/** Read-only planning uses a Git-object-only clone; it never executes repository programs or installs dependencies. */
export async function prepareQualityInvocationPlan(
  repositoryPath: string,
  input: QualityEvaluationInput,
  config: ReviewConfig,
) {
  const root = await mkdtemp(join(tmpdir(), "sheriff-quality-plan-"));
  const checkout = join(root, "checkout"),
    bundle = join(root, "review.bundle");
  try {
    await writeFile(bundle, await frozenQualityBundle(repositoryPath, input));
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--no-checkout",
        bundle,
        checkout,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    execFileSync(
      "git",
      [
        "-C",
        checkout,
        "-c",
        "core.hooksPath=/dev/null",
        "checkout",
        "--detach",
        input.headSha,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const files = new Map<string, string>();
    const sandbox = {
      async readTextFile({ path }: { path: string }) {
        return files.get(path) ?? null;
      },
      async writeTextFile({
        path,
        content,
      }: {
        path: string;
        content: string;
      }) {
        files.set(path, content);
      },
      async removePath({ path }: { path: string }) {
        for (const key of files.keys())
          if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      },
      async run({ command }: { command: string }) {
        // Only application-built Git inventory commands reach this planning surface.
        if (!command.startsWith("cd /workspace && git "))
          throw new Error("Dry-run planner refused a non-Git command");
        try {
          return {
            exitCode: 0,
            stdout: execFileSync(
              "bash",
              ["-c", command.replaceAll("/workspace", quote(checkout))],
              { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
            ),
            stderr: "",
          };
        } catch (error) {
          if (error instanceof Error && "status" in error)
            return {
              exitCode: Number(error.status),
              stdout: "",
              stderr: error.message,
            };
          throw error;
        }
      },
    };
    const workspace = await inventoryQualityWorkspace(
      input,
      config,
      sandbox,
      null,
      async () => {},
    );
    const prepared = await prepareReviewWork(
      sandbox,
      workspace.trusted,
      {
        manifest: workspace.manifest,
        requirements: workspace.requirements,
        decisions: workspace.decisions,
        config,
        claim: input.claim,
      },
      { store: null },
    );
    const schemaTokens = countPatchTokens(
      JSON.stringify(qualityWorkToolSchemas()),
    );
    return {
      headSha: input.headSha,
      workUnits: await Promise.all(
        prepared.units.map(async (unit) => {
          const packet = preparedReviewWorkPacketSchema.parse(
            JSON.parse(files.get(unit.packetPath)!),
          );
          const route = {
            role: "lane" as const,
            axis: unit.axis,
            attempt: 0,
            workId: unit.id,
          };
          const context = JSON.stringify(reviewWorkContext(packet)),
            instructions = reviewChildInstructions();
          const captured: { dispatch: ReviewChildDispatch | null } = {
            dispatch: null,
          };
          const planningOnly = new Error("Captured dry dispatch");
          await orchestrateReview({
            plan: {
              prepared: { ...prepared, units: [unit] },
              modelConfig: config,
              activeAxes: [unit.axis],
              lanes: [...(config.lanes ?? [])],
              rootSessionId: "quality-dry-run",
              attemptId: "quality-dry-run",
              commonPrefix: qualityCommonPrefix,
            },
            invocationPrefix: "quality-dry-run",
            reuseWork: async () => null,
            cancelOutstanding: async () => {},
            verifyWork: async () => {
              throw planningOnly;
            },
            call: async (dispatch) => {
              captured.dispatch = dispatch;
              throw planningOnly;
            },
          }).catch((error) => {
            if (error !== planningOnly) throw error;
          });
          if (!captured.dispatch)
            throw new Error("Dry planner did not receive production dispatch");
          const instructionTokens = countPatchTokens(instructions),
            dispatchTokens = countPatchTokens(captured.dispatch.message),
            packetTokens = countPatchTokens(context);
          const prefix = instructionTokens + dispatchTokens + schemaTokens;
          const protocolInputTokens =
            3 * prefix +
            2 * packetTokens +
            countPatchTokens(
              JSON.stringify({ workId: unit.id, status: "complete" }),
            );
          return {
            id: unit.id,
            axis: unit.axis,
            component: unit.component,
            paths: unit.paths,
            requirementIds: unit.requirementIds,
            requirementPaths: packet.requirements.map(
              (item) => item.source.path,
            ),
            inputDigest: unit.inputDigest,
            models: chainForRoute(config, route),
            reasoning: reasoningForRoute(config, route),
            packetBytes: Buffer.byteLength(context),
            packetTextTokens: packetTokens,
            instructionTextTokens: instructionTokens,
            dispatchTextTokens: dispatchTokens,
            toolSchemaTextTokens: schemaTokens,
            knownThreeStepProtocolInputTokens: protocolInputTokens,
            knownStepInputTokens: [
              prefix,
              prefix + packetTokens,
              prefix +
                packetTokens +
                countPatchTokens(
                  JSON.stringify({ workId: unit.id, status: "complete" }),
                ),
            ],
            protocol: ["read review_work", "write review_work", "final_output"],
            unmeasuredInputs: [
              "model-authored tool calls and report replay",
              "investigative source/probe outputs",
              "additional steps, continuations and retries",
              "provider framing/tokenization",
            ],
            outputTokens: null,
            totalInvocationCostUsd: null,
          };
        }),
      ),
      adjudication: {
        required: true,
        models: chainForRoute(config, {
          role: "coordinator",
          attempt: 0,
          task: "adjudication",
        }),
        knownInstructionTokens: countPatchTokens(
          reviewAdjudicationInstructions(config),
        ),
        knownToolSchemaTokens: countPatchTokens(
          JSON.stringify(
            z.toJSONSchema(z.object({ draft: reviewAdjudicationDraftSchema })),
          ),
        ),
        inputTokens: null,
        outputTokens: null,
      },
      environment: {
        executed: false,
        reason:
          "Dry planning inventories exact Git objects only; setup and required tests execute in isolated paid runs.",
      },
      reuse: {
        assumed: false,
        reason:
          "No completed model assessments exist in a dry plan; update reuse depends on observed proof.",
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
