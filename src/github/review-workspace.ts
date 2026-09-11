import { getToken } from "@vercel/connect";
import type { SandboxNetworkPolicy } from "eve/sandbox";
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

// Public dependency/tool downloads have no credential transforms. The temporary
// repository fetch policy remains scoped to the trusted GitHub repository.
export const reviewNetworkPolicy: SandboxNetworkPolicy = {
  allow: [
    "github.com", "*.github.com", "*.githubusercontent.com",
    "registry.npmjs.org", "registry.yarnpkg.com", "nodejs.org", "bun.sh",
    "deb.debian.org", "security.debian.org", "archive.ubuntu.com", "*.archive.ubuntu.com", "security.ubuntu.com", "ports.ubuntu.com",
    "cdn.amazonlinux.com", "*.amazonlinux.com", "*.amazonaws.com", "downloads.freepascal.org",
    "astral.sh", "releases.astral.sh", "pypi.org", "files.pythonhosted.org",
    "sh.rustup.rs", "static.rust-lang.org", "index.crates.io", "static.crates.io", "crates.io",
    "proxy.golang.org", "sum.golang.org", "go.dev", "dl.google.com", "storage.googleapis.com",
    "cdn.playwright.dev", "playwright.download.prss.microsoft.com", "cdn.puppeteer.dev",
  ],
  subnets: { deny: [...privateSubnets] },
};

const revisionSchema = z.string().regex(/^[a-f0-9]{40}$/);

interface ReviewWorkspaceSandbox {
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

  await sandbox.removePath({ path: ".git", recursive: true, force: true });
  await runGit(sandbox, "Git repository initialization", "init --quiet /workspace");
  await runGit(
    sandbox,
    "Git remote configuration",
    `-C /workspace remote add origin ${shellQuote(repositoryUrl(context))}`,
  );

  let credentialsBrokered = false;
  try {
    await sandbox.setNetworkPolicy(
      authenticatedGitHubPolicy(context, installationToken),
    );
    credentialsBrokered = true;
    await runGit(
      sandbox,
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
      await sandbox.setNetworkPolicy(reviewNetworkPolicy);
    }
  }

  for (const [label, expected] of [
    ["base", baseSha],
    ["head", headSha],
    ["merge-base", mergeBaseSha],
  ] as const) {
    const resolved = await runGit(
      sandbox,
      `Trusted ${label} revision validation`,
      `-C /workspace rev-parse ${shellQuote(`refs/known-good-review/${label}^{commit}`)}`,
    );
    if (String(resolved.stdout).trim() !== expected) {
      throw new Error(`Fetched trusted ${label} revision did not match GitHub`);
    }
  }

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
