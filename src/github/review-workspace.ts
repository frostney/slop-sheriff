import { getToken } from "@vercel/connect";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import { withAcquisitionSandbox, transferSandboxFile, requireSandboxCommand, type AcquisitionFactory } from "../review/sandbox-acquisition";
import { z } from "zod";
import { githubAdapter, githubConnector } from "./chat-adapter";
import type { TrustedGitHubContext } from "./trusted-context";

// Vercel rejects IPv6 CIDRs; keep this policy within its supported IPv4 surface.
const privateSubnets = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
] as const;

export const githubOnlyNetworkPolicy: SandboxNetworkPolicy = {
  allow: ["github.com", "*.github.com", "*.githubusercontent.com"],
  subnets: { deny: [...privateSubnets] },
};

// Review code, installers, and surviving background processes remain offline.
export const reviewNetworkPolicy: SandboxNetworkPolicy = "deny-all";

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);

interface ReviewWorkspaceSandbox extends Pick<SandboxSession, "writeBinaryFile"> {
  removePath(options: {
    readonly force?: boolean;
    readonly path: string;
    readonly recursive?: boolean;
  }): Promise<void>;
  run(options: { readonly command: string }): PromiseLike<{
    readonly exitCode: number;
    readonly stderr: unknown;
    readonly stdout: unknown;
  }>;
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
}

export interface ReviewWorkspaceDependencies {
  readonly createAcquisitionSandbox?: AcquisitionFactory;
  readonly getInstallationToken: (installationId: number) => Promise<string>;
  readonly getMergeBase: (context: TrustedGitHubContext) => Promise<string>;
}

const defaultDependencies: ReviewWorkspaceDependencies = {
  async getMergeBase(context) {
    const { data } = await githubAdapter(context.installationId).octokit.rest.repos.compareCommitsWithBasehead({
      owner: context.owner, repo: context.repo,
      basehead: `${context.baseSha}...${context.headSha}`,
      per_page: 1,
    });
    return data.merge_base_commit.sha;
  },
  getInstallationToken: (installationId) =>
    getToken(githubConnector, {
      installationId: String(installationId),
      subject: { type: "app" },
    }),
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function gitCommand(argumentsSource: string): string {
  return [
    "GIT_CONFIG_GLOBAL=/dev/null",
    "GIT_CONFIG_SYSTEM=/dev/null",
    "GIT_LFS_SKIP_SMUDGE=1",
    "GIT_TERMINAL_PROMPT=0",
    "git",
    argumentsSource,
  ].join(" ");
}

function commandFailure(
  operation: string,
  result: { readonly exitCode: number; readonly stderr: unknown },
): Error {
  const stderr = String(result.stderr).trim();
  return new Error(
    stderr.length > 0
      ? `${operation} failed: ${stderr.slice(0, 1_000)}`
      : `${operation} failed with exit code ${result.exitCode}`,
  );
}

async function runGit(
  sandbox: ReviewWorkspaceSandbox,
  operation: string,
  argumentsSource: string,
) {
  const result = await sandbox.run({ command: gitCommand(argumentsSource) });
  if (result.exitCode !== 0) throw commandFailure(operation, result);
  return result;
}

function repositoryUrl(context: TrustedGitHubContext): string {
  return `https://github.com/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}.git`;
}

function authenticatedGitHubPolicy(
  context: TrustedGitHubContext,
  installationToken: string,
): SandboxNetworkPolicy {
  const authorization = Buffer.from(
    `x-access-token:${installationToken}`,
  ).toString("base64");
  return {
    allow: {
      "github.com": [
        {
          match: {
            method: ["GET", "POST"],
            path: {
              startsWith: `/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}.git/`,
            },
          },
          transform: [{ headers: { authorization: `Basic ${authorization}` } }],
        },
      ],
      "*.github.com": [],
      "*.githubusercontent.com": [],
    },
    subnets: { deny: [...privateSubnets] },
  };
}

export async function prepareReviewWorkspace(
  context: TrustedGitHubContext,
  sandbox: ReviewWorkspaceSandbox,
  dependencies: ReviewWorkspaceDependencies = defaultDependencies,
): Promise<string> {
  const baseSha = revisionSchema.parse(context.baseSha);
  const headSha = revisionSchema.parse(context.headSha);
  // PR patches begin at the common ancestor, while policy comes from the
  // current base tip. Resolve the ancestor outside the untrusted sandbox.
  const mergeBaseSha = revisionSchema.parse(await dependencies.getMergeBase(context));
  const installationToken = await dependencies.getInstallationToken(
    context.installationId,
  );

  await sandbox.setNetworkPolicy("deny-all");
  await withAcquisitionSandbox(async (acquisition) => {
    await requireSandboxCommand(acquisition, "mkdir -p /workspace", "Acquisition workspace creation");
    await runGit(acquisition, "Git repository initialization", "init --quiet /workspace");
    await runGit(
      acquisition,
      "Git remote configuration",
      `-C /workspace remote add origin ${shellQuote(repositoryUrl(context))}`,
    );

    let credentialsBrokered = false;
    try {
      await acquisition.setNetworkPolicy(
        authenticatedGitHubPolicy(context, installationToken),
      );
      credentialsBrokered = true;
      await runGit(
        acquisition,
        "Trusted pull request fetch",
        [
          "-C /workspace fetch --force --no-tags --depth=1 origin",
          shellQuote(`+${baseSha}:refs/known-good-review/base`),
          shellQuote(`+${mergeBaseSha}:refs/known-good-review/merge-base`),
          shellQuote(
            `+refs/pull/${context.pullRequest}/head:refs/known-good-review/head`,
          ),
        ].join(" "),
      );
    } finally {
      if (credentialsBrokered) {
        await acquisition.setNetworkPolicy("deny-all");
      }
    }

    for (const [label, expected] of [
      ["base", baseSha],
      ["head", headSha],
      ["merge-base", mergeBaseSha],
    ] as const) {
      const resolved = await runGit(
        acquisition,
        `Trusted ${label} revision validation`,
        `-C /workspace rev-parse ${shellQuote(`refs/known-good-review/${label}^{commit}`)}`,
      );
      if (String(resolved.stdout).trim() !== expected) {
        throw new Error(`Fetched trusted ${label} revision did not match GitHub`);
      }
    }

    await requireSandboxCommand(acquisition, "tar -C /workspace -cf /tmp/review-repository.tar .git", "Repository artifact export");
    await transferSandboxFile(acquisition, sandbox, "/tmp/review-repository.tar");
  }, dependencies.createAcquisitionSandbox);
  await sandbox.removePath({ path: ".git", recursive: true, force: true });
  await requireSandboxCommand(sandbox, "tar -C /workspace -xf /tmp/review-repository.tar && rm /tmp/review-repository.tar", "Offline repository materialization");

  await runGit(
    sandbox,
    "Trusted head checkout",
    `-C /workspace checkout --detach --force ${shellQuote("refs/known-good-review/head")}`,
  );
  await runGit(
    sandbox,
    "Review workspace cleanup",
    "-C /workspace clean -ffdx",
  );
  return mergeBaseSha;
}
