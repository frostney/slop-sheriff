import { z } from "zod";
import { parseReviewConfig, type ReviewConfig } from "../config/review-config";
import type { RequirementSource } from "./requirements";
import { workHash } from "./work-plan";
import type { WorkInputSandbox } from "./work-inputs";

const configPaths = [".github/slop-sheriff.yml", ".github/known-good-review.yml"] as const;
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const setupSchema = z.object({
  revision: z.string().min(1), inputsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  tools: z.array(z.object({ name: z.string(), version: z.string().min(1) })),
  completedSteps: z.array(z.string()),
  browser: z.object({ provider: z.string(), command: z.string(), version: z.string() }).optional(),
});

function analysisConfig(config: ReviewConfig) {
  const { voice: _voice, personality: _personality, voiceGuide: _guide, voiceGuideContent: _content, tasks, ...analysis } = config;
  const { presentation: _presentation, ...analysisTasks } = tasks ?? {};
  return { ...analysis, tasks: analysisTasks };
}

/** Repository-wide conservative guard for finding revalidation observations that
 * are not captured by component work proofs. Revision labels are not inputs;
 * both tracked trees, file modes, analysis config and observed setup are. */
export async function reportRepositoryDigest(input: {
  sandbox: WorkInputSandbox; base: ReadonlyMap<string, string>; head: ReadonlyMap<string, string>;
  requirements: readonly RequirementSource[]; setup: unknown;
}): Promise<string | null> {
  const setup = setupSchema.safeParse(input.setup);
  if (!setup.success) return null; // Unknown environment cannot establish equivalence.
  async function blob(entry: string): Promise<string> {
    const id = sha.parse(entry.split(":")[2]);
    const result = await input.sandbox.run({ command: `cd /workspace && git cat-file blob ${id}` });
    if (result.exitCode !== 0) throw new Error("Could not establish report repository configuration identity");
    return String(result.stdout);
  }
  const configPath = configPaths.find(path => input.base.has(path));
  const trustedSource = configPath ? await blob(input.base.get(configPath)!) : null;
  let trusted: ReviewConfig;
  try { trusted = parseReviewConfig(trustedSource); }
  catch { return null; }
  const analysisReferences = new Set([
    ...(trusted.requirementPaths ?? []), ...(trusted.lanes ?? []).flatMap(lane => lane.referencePaths),
    ...input.requirements.flatMap(source => [source.path.split("#")[0]!, ...source.references]),
  ]);
  const analysisReference = (path: string) => [...analysisReferences].some(reference => path === reference || path.startsWith(`${reference}/`));
  const guide = trusted.voiceGuide && !analysisReference(trusted.voiceGuide) ? trusted.voiceGuide : null;
  async function treeIdentity(tree: ReadonlyMap<string, string>) {
    const values: Array<[string, unknown]> = [];
    for (const [path, entry] of [...tree].sort(([a], [b]) => a.localeCompare(b))) {
      if (path === guide) continue;
      // Only the configuration selected by the trusted base grants exclusions.
      // A dormant legacy file or a new head-only config remains ordinary source.
      if (path === configPath && !analysisReference(path)) {
        const source = await blob(entry);
        try { values.push([path, [entry.split(":")[0], analysisConfig(parseReviewConfig(source))]]); }
        catch {
          values.push([path, entry]); // Invalid head config is not presentation-only.
        }
      } else values.push([path, entry]);
    }
    return values;
  }
  const stableSetup = { ...setup.data, tools: [...setup.data.tools].sort((a,b) => a.name.localeCompare(b.name)),
    completedSteps: [...setup.data.completedSteps].sort() };
  const [base, head] = await Promise.all([treeIdentity(input.base), treeIdentity(input.head)]);
  return workHash({ revision: "report-repository-equivalence-v1", base, head, setup: stableSetup });
}
