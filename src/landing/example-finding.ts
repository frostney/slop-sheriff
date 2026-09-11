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
  evidence: [
    "A production-alias probe returned robots.txt Disallow: / alongside HTML and X-Robots-Tag noindex directives.",
    "Blocking crawl prevents discovery of noindex; Google can still list linked URLs.",
  ],
  impact: "A production alias can appear as a URL-only search result because robots.txt blocks crawlers from seeing noindex, weakening canonical-host-only indexing.",
  impactSummary: "A production alias can appear as a URL-only search result because robots.txt blocks crawlers from seeing noindex, weakening canonical-host-only indexing.",
  remedy: "Allow crawling on public aliases while returning noindex, or permanently redirect production aliases to the canonical origin.",
  status: "open",
  staticOnly: false,
  churn: null,
};
