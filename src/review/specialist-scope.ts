import type { ReviewAxis } from "./axes";
import { writingQualityApplies } from "./axes";

export function isSpecialistAxis(axis: ReviewAxis): boolean {
  return axis.startsWith("project-") || axis === "test-against-spec" || axis === "writing-quality" || axis === "test-health";
}

/** Patch selection narrows delivery, never the manifest or permission to inspect supporting evidence. */
export function specialistEntryScope(axis: ReviewAxis, path: string) {
  if (axis.startsWith("project-")) return { includePatch: true, obligation: "Verify the trusted project lane criteria against this entry and its prepared reference sources. Record independent evidence for each applicable requirement; unresolved required verification cannot complete.", reason: "Trusted project lane criteria retain complete source scope" };
  if (axis === "test-health") {
    const includePatch = /(?:^|\/)(?:tests?|__tests__|specs?|fixtures?|contracts?|requirements?|specifications?|adr)(?:\/|\.)|\.(?:test|spec)\.|\.(?:mdx?|rst|adoc|feature)$/i.test(path);
    return {
      includePatch,
      obligation: "Assess changed or affected tests as a frozen external contract of visible/public behavior. Establish explicit expectations before inspecting implementation or running candidate/mutant probes. Verify meaningful public outcomes, failure sensitivity and refactor tolerance; classify missing or unavailable evidence explicitly.",
      reason: includePatch ? "Potential test or public contract source" : "Implementation/dependency metadata; locate affected consumer-facing tests and explicit contracts without deriving expectations from current code",
    };
  }
  if (axis === "test-against-spec") {
    const includePatch = /\.(?:mdx?|rst|adoc|txt|feature)$/i.test(path) || /(?:^|\/)(?:specifications?|requirements?|decisions?|adr)(?:\/|\.)/i.test(path);
    return {
      includePatch,
      obligation: "Identify explicit requirements affected by this entry. Exercise their real delivered interface at the exact revision; record passed, failed, unverified or out-of-scope. Implementation and test-source patches cannot prove behavior. Follow directly relevant specification sources even when their patch is omitted.",
      reason: includePatch ? "Potential explicit specification source" : "Implementation metadata only; derive expectations from explicit sources and inspect the real interface",
    };
  }
  if (axis === "writing-quality") {
    const includePatch = writingQualityApplies([path]);
    return {
      includePatch,
      obligation: "Inspect changed authored prose, UI strings and substantive comments for concrete clarity defects. Record its reviewed result or an explicit reason that this entry has no authored prose; inspect directly relevant source when metadata is insufficient.",
      reason: includePatch ? "Potential authored prose, UI strings or comments" : "Binary asset or dependency lock; inspect metadata for an applicable authored-prose surface",
    };
  }
  return null;
}
