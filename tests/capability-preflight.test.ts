import { describe, expect, test } from "bun:test";
import {
  capabilityCommandNames,
  capabilityPreflightPath,
  readCapabilityPreflight,
  runCapabilityPreflight,
} from "../src/review/capability-preflight";
import { readLaneReviewEvidencePacket } from "../src/review/lane-evidence";
import {
  assembleReviewEvidenceLedger,
  writeReviewEvidenceLedger,
} from "../src/review/evidence-ledger";
import { prepareExactHeadGitHubEvidence } from "../src/review/github-evidence";
import { commonWorkFixture } from "./common-work-fixture";

const identity = {
  baseSha: "1".repeat(40),
  headSha: "2".repeat(40),
  patchFingerprint: "3".repeat(64),
};

const ledgerIdentity = {
  executionRevision: "review-evidence-v3" as const,
  repositoryId: "R_test",
  repositoryDatabaseId: 41,
  repository: "frostney/pascal-mcp-sdk",
  pullRequest: 61,
  ...identity,
  planKind: "delta" as const,
};

function sandbox() {
  const files = new Map<string, string>();
  const commands: string[] = [];
  return {
    commands,
    files,
    runtime: {
      async removePath() {},
      async readTextFile({ path }: { readonly path: string }) {
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
          stdout: [
            ...capabilityCommandNames.map(
              (name) => `command\t${name}\t${name === "git" || name === "fpc" ? "1" : "0"}`,
            ),
            "marker\tMakefile\t1",
          ].join("\n"),
        };
      },
      async writeTextFile({
        path,
        content,
      }: {
        readonly path: string;
        readonly content: string;
      }) {
        files.set(path, content);
      },
    },
  };
}

async function prepareLaneEvidence(observed: ReturnType<typeof sandbox>) {
  const capabilities = await runCapabilityPreflight(
    observed.runtime,
    identity,
  );
  const manifest = { schemaVersion: 1 as const, ...identity, entries: [] };
  const github = prepareExactHeadGitHubEvidence({
    artifactsByRun: new Map(),
    checkRuns: [],
    headSha: identity.headSha,
    observedAt: "2026-08-24T12:00:00.000Z",
    repositoryDatabaseId: ledgerIdentity.repositoryDatabaseId,
    workflowRuns: [],
  });
  await writeReviewEvidenceLedger(
    observed.runtime,
    assembleReviewEvidenceLedger({
      capabilities: capabilities.preflight,
      commonWork: commonWorkFixture(ledgerIdentity),
      github: github.evidence,
      identity: ledgerIdentity,
      manifest,
      probes: [],
    }),
  );
  return manifest;
}

describe("review capability preflight", () => {
  test("runs once and returns the same immutable result to later readers", async () => {
    const observed = sandbox();
    const first = await runCapabilityPreflight(observed.runtime, identity);
    const second = await runCapabilityPreflight(observed.runtime, identity);

    expect(first.created).toBeTrue();
    expect(second.created).toBeFalse();
    expect(observed.commands).toHaveLength(1);
    expect(second.preflight).toEqual(first.preflight);
    expect(first.preflight.network).toBe("public-dependencies");
    expect(first.preflight.repositoryMarkers).toEqual(["Makefile"]);
    expect(
      first.preflight.commands.find((command) => command.name === "fpc"),
    ).toEqual({ name: "fpc", available: true });
  });

  test("accepts a trusted identity object with unrelated context fields", async () => {
    const observed = sandbox();
    const trustedContext = {
      ...identity,
      installationId: 42,
      owner: "frostney",
      repo: "pascal-mcp-sdk",
    };
    const result = await runCapabilityPreflight(observed.runtime, trustedContext);

    expect(result.preflight).toMatchObject(identity);
    expect(result.preflight).not.toHaveProperty("installationId");
    expect(result.preflight).not.toHaveProperty("owner");
    expect(result.preflight).not.toHaveProperty("repo");
  });

  test("rejects a modified or mismatched preflight", async () => {
    const observed = sandbox();
    await runCapabilityPreflight(observed.runtime, identity);
    const path = capabilityPreflightPath(identity.patchFingerprint);
    const parsed = JSON.parse(observed.files.get(path) ?? "{}") as {
      headSha: string;
    };
    observed.files.set(path, JSON.stringify({ ...parsed, headSha: "4".repeat(40) }));

    await expect(readCapabilityPreflight(observed.runtime, identity)).rejects.toThrow(
      "does not match",
    );
  });

  test("provides the same preflight to every lane packet", async () => {
    const observed = sandbox();
    const manifest = await prepareLaneEvidence(observed);

    const engineering = await readLaneReviewEvidencePacket(
      observed.runtime,
      ledgerIdentity,
      manifest,
      "engineering-quality",
      "engineering-session",
    );
    const specification = await readLaneReviewEvidencePacket(
      observed.runtime,
      ledgerIdentity,
      manifest,
      "claim-and-specification",
      "specification-session",
    );

    expect(engineering.capabilityPreflight).toEqual(
      specification.capabilityPreflight,
    );
    expect(engineering.capabilityPreflight.digest).toBe(
      specification.capabilityPreflight.digest,
    );
    expect(engineering.ledgerDigest).toBe(specification.ledgerDigest);
    expect(engineering.commonWork).toEqual(specification.commonWork);
    expect(engineering.commonWork.records).toHaveLength(6);
    expect(observed.commands).toHaveLength(1);
  });

  test("does not advance lane evidence when preflight validation fails", async () => {
    const observed = sandbox();
    const manifest = await prepareLaneEvidence(observed);
    const path = capabilityPreflightPath(identity.patchFingerprint);
    const parsed = JSON.parse(observed.files.get(path) ?? "{}") as {
      headSha: string;
    };
    observed.files.set(path, JSON.stringify({ ...parsed, headSha: "4".repeat(40) }));
    const filesBefore = [...observed.files.keys()];

    await expect(
      readLaneReviewEvidencePacket(
        observed.runtime,
        ledgerIdentity,
        manifest,
        "engineering-quality",
        "failed-session",
      ),
    ).rejects.toThrow("does not match");
    expect([...observed.files.keys()]).toEqual(filesBefore);
  });
});
