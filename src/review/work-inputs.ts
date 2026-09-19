import { z } from "zod";
import type { RequirementSource } from "./requirements";
import { repositoryPathSchema } from "./evidence-bundle";
import {
  workHash,
  workRequirementDigest,
  type ReviewWorkUnit,
} from "./work-plan";

const revision = z.string().regex(/^[a-f0-9]{40}$/);
export interface WorkInputSandbox {
  run(input: {
    command: string;
  }): PromiseLike<{ exitCode: number; stdout: unknown; stderr: unknown }>;
}
export const workFileInputSchema = z.strictObject({
  path: repositoryPathSchema,
  base: z.string().nullable(),
  head: z.string().nullable(),
});
export const workInputSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  unitId: z.string().regex(/^[a-f0-9]{64}$/),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  requirementDigest: z.string().regex(/^[a-f0-9]{64}$/),
  claimDigest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(workFileInputSchema),
});
export type WorkInputSnapshot = z.infer<typeof workInputSnapshotSchema>;

export async function readWorkRevisionTree(
  sandbox: WorkInputSandbox,
  sha: string,
): Promise<Map<string, string>> {
  const result = await sandbox.run({
    command: `cd /workspace && git ls-tree -r -z ${revision.parse(sha)}`,
  });
  if (result.exitCode !== 0)
    throw new Error("Could not establish review work source inputs");
  const tree = new Map<string, string>();
  for (const entry of String(result.stdout).split("\0").filter(Boolean)) {
    const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match?.[4]) throw new Error("Malformed review source tree");
    tree.set(
      repositoryPathSchema.parse(match[4]),
      `${match[1]}:${match[2]}:${match[3]}`,
    );
  }
  return tree;
}

const globalInputs =
  /(?:^|\/)(?:package\.json|(?:package-lock|composer)\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|pyproject\.toml|uv\.lock|poetry\.lock|requirements[^/]*\.txt|tsconfig[^/]*\.json|Makefile|CMakeLists\.txt|Dockerfile|\.gitattributes)$/;

/** Content and directory membership, not revision labels, own semantic identity.
 * Exact supporting reads/searches add their own observed dependencies later. */
export function snapshotReviewWorkInputs(input: {
  unit: ReviewWorkUnit;
  base: ReadonlyMap<string, string>;
  head: ReadonlyMap<string, string>;
  requirements: readonly RequirementSource[];
  claim: string;
}): WorkInputSnapshot {
  const paths = new Set(input.unit.paths);
  // All files within the component belong to its contract, including previously
  // absent/new files. This also covers local negative evidence without trusting
  // a model to enumerate only the files it happened to read.
  const componentPrefix =
    input.unit.component === "repository-root" ||
    input.unit.component.startsWith("requirement:")
      ? null
      : `${input.unit.component}/`;
  for (const path of new Set([...input.base.keys(), ...input.head.keys()])) {
    if (
      globalInputs.test(path) ||
      (componentPrefix && path.startsWith(componentPrefix))
    )
      paths.add(path);
  }
  for (const source of input.requirements.filter((source) =>
    input.unit.requirementIds.includes(source.id),
  )) {
    if (!source.path.includes("#")) paths.add(source.path);
  }
  return workInputSnapshotSchema.parse({
    schemaVersion: 1,
    unitId: input.unit.id,
    policyDigest: input.unit.policyDigest,
    requirementDigest: workRequirementDigest(
      input.requirements.filter((source) =>
        input.unit.requirementIds.includes(source.id),
      ),
    ),
    claimDigest: workHash(input.claim),
    files: [...paths]
      .sort()
      .map((path) => ({
        path,
        base: input.base.get(path) ?? null,
        head: input.head.get(path) ?? null,
      })),
  });
}

export function reviewWorkInputDigest(snapshot: WorkInputSnapshot): string {
  return workHash(workInputSnapshotSchema.parse(snapshot));
}
