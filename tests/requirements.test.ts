import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractRequirementObligations, prepareRequirementInventory, readRequirementSource, requirementObligationIdentities, requirementsForAxis } from "../src/review/requirements";
import { parseReviewConfig } from "../src/config/review-config";
import { validateLaneCheckpointCoverage } from "../src/review/lane-checkpoint";
import { checkpointContent } from "./fixtures/eve-runtime-smoke/agent/lib/orchestration";

const fingerprint = "e".repeat(64);

test("discovers unchanged obligations and linked sources once at both exact revisions without trusting candidate config", async () => {
  const root = await mkdtemp(join(tmpdir(), "sheriff-requirements-"));
  const stored = new Map<string, string>();
  const blobReads: string[] = [];
  const run = async (command: string) => {
    const child = Bun.spawn(["sh", "-c", command.replaceAll("/workspace", root)], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode };
  };
  const git = async (command: string) => {
    const result = await run(`git ${command}`);
    if (result.exitCode) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const write = async (path: string, content: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); };
  const sandbox = {
    async run(input: { command: string }) { if (input.command.includes("cat-file blob")) blobReads.push(input.command); return run(input.command); },
    async readTextFile(input: { path: string }) { return stored.get(input.path) ?? null; },
    async writeTextFile(input: { path: string; content: string }) { stored.set(input.path, input.content); },
  };
  try {
    await git("init --quiet"); await git("config user.name Fixture"); await git("config user.email fixture@example.test");
    await write("AGENTS.md", "Completion requires [DoD](docs/DefinitionOfDone.md).\n");
    await write("docs/DefinitionOfDone.md", "- [ ] The CLI must reject invalid input.\n[contract](../contracts/cli.md)\n");
    await write("contracts/cli.md", "Nonzero exit and diagnostic. [cycle](../AGENTS.md)\n");
    await write("odd-layout/obligations/cli.txt", "Frozen output contract. [external requirement](https://example.test/cli-contract)\n");
    await write("unrelated/history.md", "Unrelated prose.\n");
    await write("specs/other-domain/plan.md", "Other domain must accept batch imports.\n");
    await write("docs/adr/other-domain/001-choice.md", "Other domain must use a separate store.\n");
    await write("specs/cli/contracts.md", "CLI must reject missing files.\n");
    await write("src/cli.ts", "export const valid = true;\n");
    const trustedConfig = "requirementPaths: [odd-layout/obligations]\nlanes:\n  - id: project-cli\n    name: CLI contract\n    criteria: |\n      The CLI must reject invalid inputs.\n      - [ ] Help includes usage examples.\n    referencePaths: [contracts/cli.md]\n    always: true\n  - id: project-style\n    name: Style\n    criteria: |\n      Consistent user-facing terminology.\n      Help must name the active command.\n    always: true\n  - id: project-unrelated\n    name: Unrelated\n    criteria: Do not activate outside other component.\n    referencePaths: [missing-inactive-policy.md]\n    applicability: { paths: [other-component] }\n";
    await write(".github/slop-sheriff.yml", trustedConfig);
    await git("add ."); await git("commit --quiet -m base"); const baseSha = await git("rev-parse HEAD");
    await write("docs/DefinitionOfDone.md", "No rejection required.\n");
    await unlink(join(root, "contracts/cli.md"));
    await write(".github/slop-sheriff.yml", "requirementPaths: [unrelated]\n");
    await git("add ."); await git("commit --quiet -m head"); const headSha = await git("rev-parse HEAD");
    const inventory = await prepareRequirementInventory(sandbox, { baseSha, headSha, patchFingerprint: fingerprint, paths: ["src/cli.ts"], config: parseReviewConfig(trustedConfig) });
    expect(inventory.map((source) => source.path)).toEqual(expect.arrayContaining(["AGENTS.md", "docs/DefinitionOfDone.md", "contracts/cli.md", "odd-layout/obligations/cli.txt"]));
    expect(inventory.some((source) => source.path === "unrelated/history.md")).toBe(false);
    expect(inventory.some((source) => source.path === "specs/other-domain/plan.md")).toBe(false);
    expect(inventory.some((source) => source.path === "docs/adr/other-domain/001-choice.md")).toBe(false);
    expect(inventory.some((source) => source.path === "specs/cli/contracts.md")).toBe(true);
    expect(new Set(blobReads).size).toBe(blobReads.length);
    const custom = requirementsForAxis(inventory, "project-cli");
    expect(custom.map((source) => source.path)).toEqual(expect.arrayContaining(["contracts/cli.md", ".github/slop-sheriff.yml#lanes.project-cli.criteria"]));
    const criteria = custom.find((source) => source.path.includes("#lanes."))!;
    expect(criteria.obligations).toHaveLength(2);
    expect(requirementsForAxis(inventory, "project-style")[0]?.obligations).toHaveLength(2);
    expect(requirementsForAxis(inventory, "project-unrelated")).toEqual([]);
    expect((await readRequirementSource(sandbox, fingerprint, inventory, criteria.id)).content).toContain("The CLI must reject invalid inputs");
    const customCheckpoint = checkpointContent("project-cli");
    customCheckpoint.reviewedEntries = [0];
    customCheckpoint.completedReport!.specialistChecks = [{ entries: [0], requirement: "All code reviewed", source: "src/cli.ts", expected: "Review scope covered", environment: "source", action: "inspect", observed: "all covered", status: "passed" }];
    expect(() => validateLaneCheckpointCoverage(customCheckpoint, 1, custom.map((source) => source.id), requirementObligationIdentities(custom))).toThrow("every explicit criterion");
    expect(inventory.find((entry) => entry.path === "odd-layout/obligations/cli.txt")?.references).toContain("https://example.test/cli-contract");
    const source = inventory.find((entry) => entry.path === "docs/DefinitionOfDone.md")!;
    const result = await readRequirementSource(sandbox, fingerprint, inventory, source.id);
    expect(result.content).toContain("The CLI must reject invalid input");
    expect(result.content).toContain("No rejection required");
    expect(result.content).toContain(baseSha); expect(result.content).toContain(headSha);
    expect(inventory.find((entry) => entry.path === "contracts/cli.md")).toMatchObject({ headBlob: null });
    const storedPath = [...stored.keys()].find((path) => path.includes(source.id))!;
    stored.set(storedPath, "forged obligations");
    await expect(readRequirementSource(sandbox, fingerprint, inventory, source.id)).rejects.toThrow("integrity");
    await expect(prepareRequirementInventory(sandbox, { baseSha, headSha, patchFingerprint: fingerprint, paths: ["src/cli.ts"], config: { requirementPaths: ["absent"], lanes: [] } })).rejects.toThrow("trusted base");
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("unchanged requirement sources are independent completion obligations and unverified outcomes fail closed", () => {
  const checkpoint = checkpointContent("claim-and-specification");
  checkpoint.reviewedEntries = [0];
  const report = checkpoint.completedReport!;
  const sourceId = `req-${"a".repeat(24)}`;
  expect(() => validateLaneCheckpointCoverage(checkpoint, 1, [sourceId])).toThrow("every prepared source");
  const check = { sourceId, obligationId: null, basis: "established" as const, requirement: "Reject invalid CLI input", establishedRequirement: "DoD at base: reject invalid input", proposedChange: "Head removes obligation", approvalEvidence: null, expected: "Exit 1", observed: "Exit 0", action: "cli --invalid", environment: "Exact head CLI", status: "failed" as const };
  report.requirementChecks = [check];
  expect(() => validateLaneCheckpointCoverage(checkpoint, 1, [sourceId])).not.toThrow();
  report.requirementChecks = [{ ...check, basis: "approved-change" }];
  expect(() => validateLaneCheckpointCoverage(checkpoint, 1, [sourceId])).toThrow("explicit maintainer approval evidence");
  report.requirementChecks = [{ ...check, basis: "approved-change", approvalEvidence: "Maintainer decision URL with author and approved scope" }];
  expect(() => validateLaneCheckpointCoverage(checkpoint, 1, [sourceId])).not.toThrow();
  report.requirementChecks = [{ ...check, status: "unverified" }];
  expect(() => validateLaneCheckpointCoverage(checkpoint, 1, [sourceId])).toThrow("Required verification remains unverified");
  report.requirementChecks = [{ ...check, status: "out-of-scope", basis: "not-applicable", observed: "This source governs an unchanged separate CLI; the changed HTTP component does not call it" }];
  expect(() => validateLaneCheckpointCoverage(checkpoint, 1, [sourceId])).not.toThrow();
  expect(() => validateLaneCheckpointCoverage(checkpoint, 1, [])).toThrow("prepared source IDs");
});


test("a source pass cannot hide a second explicit acceptance criterion or erase a removed base obligation", () => {
  const base = "# Definition of Done\n- [ ] CLI rejects invalid input.\n- [x] Help includes usage examples.\nThe CLI must return JSON. It shall reject unsupported formats.\n```ts\nconst example = 'must not become a criterion';\n```";
  const head = "# Definition of Done\n- [x] CLI rejects invalid input.\nThe CLI must return JSON. It shall reject unsupported formats.";
  const obligations = extractRequirementObligations("docs/DoD.md", base, head);
  expect(obligations).toHaveLength(4);
  expect(obligations.find((item) => item.base?.text === "Help includes usage examples.")).toMatchObject({ base: { line: 3 }, head: null });
  expect(obligations.find((item) => item.base?.text === "CLI rejects invalid input.")).toMatchObject({ base: { line: 2 }, head: { line: 2 } });
  const sourceId = `req-${"c".repeat(24)}`;
  const content = checkpointContent("claim-and-specification");
  const checks = obligations.map((obligation) => ({ sourceId, obligationId: obligation.id, requirement: obligation.base?.text ?? "new claim", basis: "established" as const, establishedRequirement: `docs/DoD.md:${obligation.base?.line}`, proposedChange: obligation.head ? "retained" : "removed without approval", approvalEvidence: null, expected: "Documented public outcome", observed: "Executed public outcome matches", action: "Run frozen independent CLI contract", environment: "Exact head CLI", status: "passed" as const }));
  const required = obligations.map((obligation) => ({ id: obligation.id, sourceId }));
  content.completedReport!.requirementChecks = checks.slice(0, 1);
  expect(() => validateLaneCheckpointCoverage(content, 0, [sourceId], required)).toThrow("every explicit criterion");
  content.completedReport!.requirementChecks = checks;
  expect(() => validateLaneCheckpointCoverage(content, 0, [sourceId], required)).not.toThrow();
});
