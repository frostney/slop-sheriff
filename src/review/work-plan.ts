import { createHash } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { reviewAxisSchema, type ReviewAxis } from "./axes";
import {
  repositoryPathSchema,
  type ReviewEvidenceManifest,
} from "./evidence-bundle";
import type { RequirementSource } from "./requirements";
import type { ReviewAxisDecision } from "./axis-selection";
import { reviewWorkInstructions } from "./policy";
import type { ReviewConfig } from "../config/review-config";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const workHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const reviewWorkUnitSchema = z.strictObject({
  id: digest,
  axis: reviewAxisSchema,
  component: z.string().min(1),
  paths: z.array(repositoryPathSchema),
  requirementIds: z.array(z.string()),
  policyDigest: digest,
});
export type ReviewWorkUnit = z.infer<typeof reviewWorkUnitSchema>;
export const reviewWorkPlanSchema = z.strictObject({
  schemaVersion: z.literal(1),
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
  patchFingerprint: digest,
  units: z.array(reviewWorkUnitSchema),
});
export type ReviewWorkPlan = z.infer<typeof reviewWorkPlanSchema>;
export const reviewWorkPlanPath = (fingerprint: string): string =>
  `/tmp/known-good-review/work/${digest.parse(fingerprint)}/plan.json`;

/** Presentation and unrelated lane configuration cannot invalidate analysis. */
export function workAnalysisPolicyDigest(
  axis: ReviewAxis,
  config: Pick<ReviewConfig, "lanes">,
): string {
  const policies = [reviewWorkInstructions(axis)];
  return workHash({
    version: "component-assessment-v1",
    axis,
    policies,
    criteria: config.lanes?.find((lane) => lane.id === axis) ?? null,
  });
}

function component(path: string): string {
  const directory = posix.dirname(path);
  return directory === "." ? "repository-root" : directory;
}

function appliesToComponent(
  source: RequirementSource,
  paths: readonly string[],
): boolean {
  if (source.reason === "governance" || source.reason === "configured")
    return true;
  const directory = posix.dirname(source.path);
  const localDirectory = ![".", "docs", "doc", ".github"].includes(directory);
  return paths.some(
    (path) =>
      path === source.path ||
      source.references.includes(path) ||
      source.referencedBy.includes(path) ||
      (localDirectory && path.startsWith(`${directory}/`)),
  );
}

function requirementPaths(
  source: RequirementSource,
  selected: readonly string[],
  inventory: readonly RequirementSource[],
): string[] {
  const directory = posix.dirname(source.path);
  // Global governance and trusted configured obligations retain their declared breadth.
  if (
    source.reason === "configured" ||
    (source.reason === "governance" &&
      [".", "docs", ".github"].includes(directory))
  )
    return [...selected];
  const references = new Set([...source.references, ...source.referencedBy]);
  const seen = new Set([source.path]);
  const parents = [...source.referencedBy];
  // A referenced clause inherits the concrete surface of its referring documents.
  for (const path of parents) {
    if (seen.has(path)) continue;
    seen.add(path);
    const parent = inventory.find((item) => item.path === path);
    if (!parent) continue;
    for (const reference of [...parent.references, ...parent.referencedBy])
      references.add(reference);
    parents.push(...parent.referencedBy);
  }
  const localReferences = [...references].filter(
    (path) => !/^[a-z][a-z0-9+.-]*:/i.test(path),
  );
  const local = ![".", "docs", "doc", ".github"].includes(directory);
  const attributed = selected.filter(
    (path) =>
      localReferences.some(
        (reference) => path === reference || path.startsWith(`${reference}/`),
      ) ||
      (local && path.startsWith(`${directory}/`)),
  );
  // A changed source alone does not prove that unrelated implementation is irrelevant.
  // Unknown applicability must stay broad rather than discard an obligation.
  const isDocument = (path: string) =>
    /\.(?:mdx?|rst|adoc|txt|feature)$/i.test(path);
  if (
    attributed.length === 0 ||
    (selected.some((path) => !isDocument(path)) && attributed.every(isDocument))
  )
    return [...selected];
  return [
    ...new Set([
      ...attributed,
      ...selected.filter((path) => path === source.path),
    ]),
  ];
}

/** Each requirement is assessed once; specialists receive only their selected surface. */
export function buildReviewWorkPlan(input: {
  manifest: ReviewEvidenceManifest;
  decisions: readonly ReviewAxisDecision[];
  requirements: readonly RequirementSource[];
  config: Pick<ReviewConfig, "lanes">;
}): ReviewWorkPlan {
  const allPaths = input.manifest.entries.map((entry) => entry.path);
  const units: ReviewWorkUnit[] = [];
  const add = (
    axis: ReviewAxis,
    scope: string,
    paths: readonly string[],
    sources: readonly RequirementSource[],
  ) => {
    units.push(
      reviewWorkUnitSchema.parse({
        id: workHash(["component-assessment-v1", axis, scope]),
        axis,
        component: scope,
        paths: [...new Set(paths)].sort(),
        requirementIds: [...new Set(sources.map((source) => source.id))].sort(),
        policyDigest: workAnalysisPolicyDigest(axis, input.config),
      }),
    );
  };
  for (const decision of input.decisions.filter((item) => item.selected)) {
    if (decision.axis === "deduplication") continue;
    const selected = decision.paths.filter((path) => allPaths.includes(path));
    if (decision.axis === "claim-and-specification") {
      for (const source of input.requirements.filter(
        (source) => source.kind === "document",
      )) {
        add(
          decision.axis,
          `requirement:${source.id}`,
          requirementPaths(source, selected, input.requirements),
          [source],
        );
      }
      // Code-only changes still need claim alignment when no written source exists.
      if (input.requirements.some((source) => source.kind === "document"))
        continue;
    }
    const groups = new Map<string, string[]>();
    for (const path of selected) {
      const scope = component(path);
      const paths = groups.get(scope) ?? [];
      paths.push(path);
      groups.set(scope, paths);
    }
    if (
      !groups.size &&
      (decision.axis === "engineering-quality" ||
        decision.axis.startsWith("project-"))
    )
      groups.set("repository-root", []);
    for (const [scope, paths] of groups) {
      const sources = input.requirements.filter((source) =>
        decision.axis.startsWith("project-")
          ? source.laneIds.some((laneId) => laneId === decision.axis)
          : source.kind === "document" && appliesToComponent(source, paths),
      );
      add(decision.axis, scope, paths, sources);
    }
  }
  const corePaths = new Set(
    units
      .filter((unit) => unit.axis === "engineering-quality")
      .flatMap((unit) => unit.paths),
  );
  if (allPaths.some((path) => !corePaths.has(path)))
    throw new Error("Component planning omitted changed-file core coverage");
  if (new Set(units.map((unit) => unit.id)).size !== units.length)
    throw new Error("Duplicate component assessment identity");
  return reviewWorkPlanSchema.parse({
    schemaVersion: 1,
    baseSha: input.manifest.baseSha,
    headSha: input.manifest.headSha,
    patchFingerprint: input.manifest.patchFingerprint,
    units,
  });
}

export function workRequirementDigest(
  sources: readonly RequirementSource[],
): string {
  return workHash(
    [...sources]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((source) => ({
        id: source.id,
        baseBlob: source.baseBlob,
        headBlob: source.headBlob,
        obligations: source.obligations,
        references: [...source.references].sort(),
      })),
  );
}

export function workUnitManifest(
  manifest: ReviewEvidenceManifest,
  unit: ReviewWorkUnit,
): ReviewEvidenceManifest {
  const entries = unit.paths.map((path) => {
    const entry = manifest.entries.find((candidate) => candidate.path === path);
    if (!entry)
      throw new Error(
        "Assessment path is outside the current changed-file manifest",
      );
    return entry;
  });
  return { ...manifest, entries };
}
