import type { ReviewFinding } from "../review/findings";

export const exampleFindingSource = "https://github.com/frostney/slop-sheriff/pull/42#discussion_r3984696250";

// Condensed from the published PR #42 finding, preserving its observed trigger and consequence.
// The source thread records the subsequent fix; this is a historical finding, not a current defect.
export const exampleFinding: ReviewFinding = {
  id: "CR-2",
  severity: "IMPORTANT",
  category: "CLAIM",
  title: "Do not block crawlers from seeing the alias noindex directive",
  location: { path: "src/landing/routes.ts", line: 31, symbol: "landingResponse" },
  introduction: "Well, my circuits found a standoff: robots.txt blocks crawlers from reading the alias’s noindex directive. Both controls look sensible alone, partner, but together they prevent the indexing rule from doing its job.",
  principle: "Google requires crawler access to discover and honor a noindex directive.",
  risk: "Linked alias URLs can appear in search results while crawlers remain unable to read noindex.",
  evidence: [
    "A production-alias probe returned robots.txt Disallow: / alongside HTML and X-Robots-Tag noindex directives.",
  ],
  impact: "A production alias can appear as a URL-only search result because robots.txt blocks crawlers from seeing noindex, weakening canonical-host-only indexing.",
  impactSummary: "A production alias can appear as a URL-only search result because robots.txt blocks crawlers from seeing noindex, weakening canonical-host-only indexing.",
  remedy: "Allow crawling on public aliases while returning noindex, or permanently redirect production aliases to the canonical origin.",
  status: "open",
  staticOnly: false,
  churn: null,
};
