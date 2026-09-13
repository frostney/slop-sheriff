import { expect, test } from "bun:test";
import {
  buildReviewWorkPlan,
  workAnalysisPolicyDigest,
  workRequirementDigest,
} from "../src/review/work-plan";
import { parseReviewConfig } from "../src/config/review-config";
import type { ReviewEvidenceManifest } from "../src/review/evidence-bundle";
import type { RequirementSource } from "../src/review/requirements";

const hash = "a".repeat(64);
const manifest: ReviewEvidenceManifest = {
  schemaVersion: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  patchFingerprint: hash,
  entries: [
    "src/payments/charge.ts",
    "src/payments/refund.ts",
    "docs/install.md",
  ].map((path, index) => ({
    path,
    status: "modified",
    kind: "included",
    patchCharacters: 10,
    patchTokens: 3,
    patchSha256: hash,
    patchFile: `patch-${String(index).repeat(64)}.diff`,
  })),
};
const requirement: RequirementSource = {
  id: `req-${"a".repeat(24)}`,
  kind: "document",
  path: "docs/install.md",
  reason: "changed",
  referencedBy: [],
  references: [],
  obligations: [],
  laneIds: [],
  baseBlob: "c".repeat(40),
  headBlob: "d".repeat(40),
  contentDigest: hash,
  characters: 100,
};
const decisions = [
  {
    axis: "engineering-quality" as const,
    selected: true,
    paths: manifest.entries.map((entry) => entry.path),
    reason: "core",
  },
  {
    axis: "deduplication" as const,
    selected: true,
    paths: ["src/payments/charge.ts"],
    reason: "reuse",
  },
  {
    axis: "writing-quality" as const,
    selected: true,
    paths: ["docs/install.md"],
    reason: "prose",
  },
  {
    axis: "claim-and-specification" as const,
    selected: true,
    paths: manifest.entries.map((entry) => entry.path),
    reason: "requirements",
  },
];

test("overlapping technical perspectives share one component assessment and prose stays scoped", () => {
  const plan = buildReviewWorkPlan({
    manifest,
    decisions,
    requirements: [requirement],
    config: parseReviewConfig(null),
  });
  expect(
    plan.units
      .filter((unit) => unit.axis === "engineering-quality")
      .map((unit) => unit.paths),
  ).toEqual([
    ["src/payments/charge.ts", "src/payments/refund.ts"],
    ["docs/install.md"],
  ]);
  expect(plan.units.some((unit) => unit.axis === "deduplication")).toBe(false);
  expect(
    plan.units.find((unit) => unit.axis === "writing-quality")?.paths,
  ).toEqual(["docs/install.md"]);
  expect(
    plan.units.filter((unit) => unit.axis === "claim-and-specification"),
  ).toHaveLength(1);
});

test("new heads preserve component identities but never lose newly changed-file coverage", () => {
  const one = buildReviewWorkPlan({
    manifest,
    decisions,
    requirements: [],
    config: parseReviewConfig(null),
  });
  const two = buildReviewWorkPlan({
    manifest: { ...manifest, headSha: "c".repeat(40) },
    decisions,
    requirements: [],
    config: parseReviewConfig(null),
  });
  expect(two.units).toEqual(one.units);
  expect(() =>
    buildReviewWorkPlan({
      manifest,
      decisions: decisions.filter(
        (decision) => decision.axis === "writing-quality",
      ),
      requirements: [],
      config: parseReviewConfig(null),
    }),
  ).toThrow("omitted");
});

test("sharing the generic docs directory does not attach every historical document to every specialist", () => {
  const audit = {
    ...requirement,
    id: `req-${"b".repeat(24)}`,
    path: "docs/old-audit.md",
    reason: "reference" as const,
  };
  const plan = buildReviewWorkPlan({
    manifest,
    decisions,
    requirements: [requirement, audit],
    config: parseReviewConfig(null),
  });
  const writing = plan.units.find((unit) => unit.axis === "writing-quality")!;
  expect(writing.requirementIds).toEqual([requirement.id]);
  expect(
    plan.units.some(
      (unit) =>
        unit.axis === "claim-and-specification" &&
        unit.requirementIds.includes(audit.id),
    ),
  ).toBe(true);
  const linked = buildReviewWorkPlan({
    manifest,
    decisions,
    requirements: [requirement, { ...audit, referencedBy: [requirement.path] }],
    config: parseReviewConfig(null),
  });
  expect(
    linked.units.find((unit) => unit.axis === "writing-quality")!
      .requirementIds,
  ).toContain(audit.id);
});

test("voice and revision wrappers cannot invalidate substantive analysis policy or requirement content", () => {
  expect(
    workAnalysisPolicyDigest(
      "engineering-quality",
      parseReviewConfig("personality: false"),
    ),
  ).toBe(
    workAnalysisPolicyDigest("engineering-quality", parseReviewConfig(null)),
  );
  expect(
    workRequirementDigest([{ ...requirement, contentDigest: "b".repeat(64) }]),
  ).toBe(workRequirementDigest([requirement]));
  expect(
    workRequirementDigest([{ ...requirement, headBlob: "e".repeat(40) }]),
  ).not.toBe(workRequirementDigest([requirement]));
});

test("disjoint explicit requirement references preserve independent scope and input validity", async () => {
  const { snapshotReviewWorkInputs, reviewWorkInputDigest } =
    await import("../src/review/work-inputs");
  const paths = ["src/a/index.ts", "src/b/index.ts", "docs/a.md"];
  const scopedManifest = {
    ...manifest,
    entries: paths.map((path, index) => ({
      ...manifest.entries[index % manifest.entries.length]!,
      path,
    })),
  };
  const sources: RequirementSource[] = [
    {
      ...requirement,
      id: `req-${"a".repeat(24)}`,
      path: "docs/a.md",
      reason: "reference",
      references: ["src/a/index.ts"],
      obligations: [
        {
          id: `ob-${"a".repeat(24)}`,
          base: { line: 1, text: "A must reject invalid input" },
          head: { line: 1, text: "A must reject invalid input" },
        },
      ],
    },
    {
      ...requirement,
      id: `req-${"b".repeat(24)}`,
      path: "docs/b.md",
      reason: "reference",
      references: ["src/b/index.ts"],
    },
  ];
  const core = {
    axis: "engineering-quality" as const,
    selected: true,
    paths,
    reason: "core",
  };
  const spec = { ...core, axis: "claim-and-specification" as const };
  const plan = buildReviewWorkPlan({
    manifest: scopedManifest,
    decisions: [core, spec],
    requirements: sources,
    config: { lanes: [] },
  });
  const a = plan.units.find(
    (unit) =>
      unit.axis === "claim-and-specification" &&
      unit.requirementIds.includes(sources[0]!.id),
  )!;
  const b = plan.units.find(
    (unit) =>
      unit.axis === "claim-and-specification" &&
      unit.requirementIds.includes(sources[1]!.id),
  )!;
  expect(a.paths).toEqual(["docs/a.md", "src/a/index.ts"]);
  expect(b.paths).toEqual(["src/b/index.ts"]);
  expect(a.requirementIds).toEqual([sources[0]!.id]);
  const head = new Map([...paths, "docs/b.md"].map((path) => [path, "same"])),
    base = new Map(head);
  const snapshot = () =>
    snapshotReviewWorkInputs({
      unit: a,
      head,
      base,
      requirements: sources,
      claim: "Preserve both contracts",
    });
  const original = reviewWorkInputDigest(snapshot());
  head.set("src/b/index.ts", "changed unrelated implementation");
  expect(reviewWorkInputDigest(snapshot())).toBe(original);
  head.set("docs/a.md", "changed assigned source");
  expect(reviewWorkInputDigest(snapshot())).not.toBe(original);
});

test("requirement scopes use observed referrers and local scope but preserve unknown/global coverage", () => {
  const paths = ["src/a/index.ts", "src/b/index.ts"];
  const scopedManifest = {
    ...manifest,
    entries: paths.map((path, index) => ({
      ...manifest.entries[index]!,
      path,
    })),
  };
  const decisions = [
    {
      axis: "engineering-quality" as const,
      selected: true,
      paths,
      reason: "core",
    },
    {
      axis: "claim-and-specification" as const,
      selected: true,
      paths,
      reason: "spec",
    },
  ];
  const scope = (source: RequirementSource) =>
    buildReviewWorkPlan({
      manifest: scopedManifest,
      decisions,
      requirements: [source],
      config: { lanes: [] },
    }).units.find((unit) => unit.axis === "claim-and-specification")!.paths;
  expect(
    scope({
      ...requirement,
      path: "docs/reference.md",
      reason: "reference",
      references: [],
      referencedBy: ["src/a/index.ts"],
    }),
  ).toEqual(["src/a/index.ts"]);
  expect(
    scope({
      ...requirement,
      path: "src/a/behavior.md",
      reason: "related",
      references: [],
    }),
  ).toEqual(["src/a/index.ts"]);
  expect(
    scope({
      ...requirement,
      path: "docs/unmapped.md",
      reason: "related",
      references: [],
    }),
  ).toEqual(paths);
  expect(
    scope({
      ...requirement,
      path: "AGENTS.md",
      reason: "governance",
      references: ["src/a/index.ts"],
    }),
  ).toEqual(paths);
});

test("referenced clauses inherit their referring document's implementation scope", () => {
  const paths = ["src/a/index.ts", "src/b/index.ts", "docs/a.md"];
  const scopedManifest = {
    ...manifest,
    entries: paths.map((path, index) => ({
      ...manifest.entries[index]!,
      path,
    })),
  };
  const parent = {
    ...requirement,
    path: "docs/a.md",
    references: ["src/a/index.ts", "docs/shared.md"],
    reason: "reference" as const,
  };
  const child = {
    ...requirement,
    id: `req-${"c".repeat(24)}`,
    path: "docs/shared.md",
    references: [],
    referencedBy: ["docs/a.md"],
    reason: "reference" as const,
  };
  const decisions = [
    {
      axis: "engineering-quality" as const,
      selected: true,
      paths,
      reason: "core",
    },
    {
      axis: "claim-and-specification" as const,
      selected: true,
      paths,
      reason: "spec",
    },
  ];
  const plan = buildReviewWorkPlan({
    manifest: scopedManifest,
    decisions,
    requirements: [parent, child],
    config: { lanes: [] },
  });
  expect(
    plan.units.find(
      (unit) =>
        unit.axis === "claim-and-specification" &&
        unit.requirementIds.includes(child.id),
    )!.paths,
  ).toEqual(["docs/a.md", "src/a/index.ts"]);
});
