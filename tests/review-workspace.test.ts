import { describe, expect, test } from "bun:test";
import type { SandboxNetworkPolicy } from "eve/sandbox";
import {
  reviewNetworkPolicy,
  prepareReviewWorkspace,
} from "../src/github/review-workspace";
import type { TrustedGitHubContext } from "../src/github/trusted-context";

const baseSha = "1".repeat(40);
const headSha = "2".repeat(40);
const context: TrustedGitHubContext = {
  installationId: 41,
  owner: "frostney",
  repo: "pascal-mcp-sdk",
  repository: "frostney/pascal-mcp-sdk",
  repositoryCreatedAt: 0,
  repositoryId: "R_repo",
  pullRequest: 53,
  baseSha,
  headSha,
};

function sandbox(options: { readonly fetchExitCode?: number } = {}) {
  const commands: string[] = [];
  const policies: SandboxNetworkPolicy[] = [];
  const removed: string[] = [];
  return {
    commands,
    policies,
    removed,
    runtime: {
      async removePath(input: { readonly path: string }) {
        removed.push(input.path);
      },
      async run({ command }: { readonly command: string }) {
        commands.push(command);
        if (command.includes(" fetch ")) {
          return {
            exitCode: options.fetchExitCode ?? 0,
            stdout: "",
            stderr: options.fetchExitCode ? "repository unavailable" : "",
          };
        }
        if (command.includes("refs/known-good-review/base^{commit}")) {
          return { exitCode: 0, stdout: `${baseSha}\n`, stderr: "" };
        }
        if (command.includes("refs/known-good-review/head^{commit}")) {
          return { exitCode: 0, stdout: `${headSha}\n`, stderr: "" };
        }
        if (command.includes("refs/known-good-review/merge-base^{commit}")) {
          return { exitCode: 0, stdout: `${baseSha}\n`, stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async setNetworkPolicy(policy: SandboxNetworkPolicy) {
        policies.push(policy);
      },
    },
  };
}

describe("review workspace preparation", () => {
  test("rejects an invalid merge base before changing the sandbox", async () => {
    const observed = sandbox();
    await expect(prepareReviewWorkspace(context, observed.runtime, {
      getMergeBase: async () => "not-a-revision",
      getInstallationToken: async () => { throw new Error("must not request credentials"); },
    })).rejects.toThrow();
    expect(observed.commands).toEqual([]);
    expect(observed.policies).toEqual([]);
    expect(observed.removed).toEqual([]);
  });

  test("fetches and checks out the exact pull request without exposing its token", async () => {
    const observed = sandbox();
    await prepareReviewWorkspace(context, observed.runtime, {
      getMergeBase: async () => baseSha,
      getInstallationToken: async (installationId) => {
        expect(installationId).toBe(41);
        return "secret-installation-token";
      },
    });

    expect(observed.removed).toEqual([".git"]);
    expect(observed.policies).toHaveLength(2);
    expect(observed.policies.at(-1)).toEqual(reviewNetworkPolicy);
    expect(observed.commands.join("\n")).not.toContain(
      "secret-installation-token",
    );
    expect(observed.commands).toEqual([
      expect.stringContaining("git init --quiet /workspace"),
      expect.stringContaining(
        "remote add origin 'https://github.com/frostney/pascal-mcp-sdk.git'",
      ),
      expect.stringContaining(
        "+refs/pull/53/head:refs/known-good-review/head",
      ),
      expect.stringContaining("refs/known-good-review/base^{commit}"),
      expect.stringContaining("refs/known-good-review/head^{commit}"),
      expect.stringContaining("refs/known-good-review/merge-base^{commit}"),
      expect.stringContaining("checkout --detach --force"),
      expect.stringContaining("clean -ffdx"),
    ]);
  });

  test("removes brokered credentials when the fetch fails", async () => {
    const observed = sandbox({ fetchExitCode: 1 });
    await expect(
      prepareReviewWorkspace(context, observed.runtime, {
        getMergeBase: async () => baseSha,
        getInstallationToken: async () => "secret-installation-token",
      }),
    ).rejects.toThrow("Trusted pull request fetch failed");
    expect(observed.policies).toHaveLength(2);
    expect(observed.policies.at(-1)).toEqual(reviewNetworkPolicy);
  });
});
