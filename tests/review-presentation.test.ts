import { describe, expect, test } from "bun:test";
import {
  findingBody,
  findingBodyHtml,
  findingWordCount,
  reviewResultBody,
  nativeReviewBody,
} from "../src/github/review-presentation";
import { reviewCommentLocation } from "../src/github/publication";
import type { ReviewFinding, ReviewReport } from "../src/review/findings";
import { findingReactions, siteOrigin } from "../src/branding";

function finding(
  severity: ReviewFinding["severity"] = "IMPORTANT",
): ReviewFinding {
  return {
    id: "CR-1",
    severity,
    category: "QUALITY",
    title: "The result loses its code location",
    location: { path: "src/review.ts", line: 11, symbol: null },
    evidence: ["The changed branch drops the recorded line."],
    impact: "Readers cannot inspect the affected code directly.",
    remedy: "Attach the finding to the changed line.",
    status: "open",
    staticOnly: false,
    churn: null,
  };
}

function report(findings: readonly ReviewFinding[]): ReviewReport {
  return {
    schemaVersion: 2,
    kind: "code-review",
    generatedAt: "2026-08-17T18:00:00.000Z",
    verdict: findings.length === 0 ? "APPROVE" : "REQUEST_CHANGES",
    scope: {
      claim: "Publish a native review result",
      base: "base",
      head: "head",
      dirtyState: "clean",
    },
    coverage: {
      activeAxes: [
        "deduplication",
        "claim-and-specification",
        "engineering-quality",
      ],
      skippedAxes: [],
      staticOnly: [],
      unreached: [],
    },
    churn: { window: "90 days", symbolCoverage: [], fileFallbacks: [] },
    probes: [],
    findings: [...findings],
    verifiedClaims: [],
    limitations: [],
  };
}

describe("native GitHub review presentation", () => {
  test("uses matching reusable reactions in both renderers and omits them with personality off", () => {
    const urls = new Set<string>();
    for (const severity of Object.keys(findingReactions) as ReviewFinding["severity"][]) {
      const input = finding(severity);
      const { filename, alt } = findingReactions[severity];
      const body = findingBody(input);
      const html = findingBodyHtml(input);
      expect(body).toContain(`src="${siteOrigin}/assets/${filename}"`);
      expect(html).toContain(`src="/assets/${filename}"`);
      for (const output of [body, html]) {
        expect(output).toContain(`width="64" height="64" align="right" alt="${alt}"`);
        expect(output).not.toContain("base64,");
      }
      urls.add(filename);
      expect(findingBody(input, "line", false)).not.toContain("<img");
      expect(findingBodyHtml(input, "line", false)).not.toContain("<img");
    }
    expect(urls.size).toBe(4);
  });
  test("uses semantic finding identity instead of the run-local CR number", () => {
    const first = findingBody(finding());
    const renumbered = findingBody({
      ...finding(),
      id: "CR-9",
      location: { path: "src/moved.ts", line: 42, symbol: "publish" },
    });
    const unrelated = findingBody({
      ...finding(),
      title: "The release omits the generated manifest",
      impact: "Published release documentation can describe stale artifacts.",
      remedy: "Regenerate the manifest before publishing the release.",
    });
    const identity = (body: string) =>
      body.match(/known-good-review:finding:v2:([a-f0-9]{64}):CR-[1-9]\d*/)?.[1];

    expect(identity(first)).toBeDefined();
    expect(identity(renumbered)).toBe(identity(first));
    expect(identity(unrelated)).not.toBe(identity(first));
  });

  test("shares the agreed format and exact authored prose between GitHub and the landing page", () => {
    const input = { ...finding(), introduction: "Partner, this result drops its recorded code location before publication, leaving readers to hunt through the change even though the review already knows exactly where the defect occurs.", principle: "Review findings need an actionable source location.", risk: "Every reader of this finding loses the direct route to the affected code." };
    for (const personality of [true, false]) {
      const body = findingBody(input, "line", personality);
      const html = findingBodyHtml(input, "line", personality);
      expect(body).toContain("### ⚠️ The result loses its code location");
      expect(body).toContain("**Important**");
      expect(body).not.toContain("Quality · Open");
      expect(body).toContain("<summary>Evidence and recommended change</summary>");
      expect(html).toContain("<summary>Evidence and recommended change</summary>");
      expect(body).toContain("Attach the finding to the changed line");
      expect(body.indexOf("Impact:")).toBeLessThan(body.indexOf("Risk:"));
      expect(body).not.toContain("Hold up there");
      expect(findingWordCount(body)).toBeLessThanOrEqual(200);
    }
  });

  test("rejects long comments, invalid introductions and em dashes before publication", () => {
    expect(() => findingBody({ ...finding(), evidence: ["A concrete observation. ".repeat(80)] })).toThrow("200-word inline limit");
    expect(() => findingBody({ ...finding(), introduction: "Too short." })).toThrow("25 to 45 words");
    expect(() => findingBody({ ...finding(), evidence: ["A defect\u2014with consequences."] })).toThrow("em dashes");
  });

  test("keeps authored markup inert in every visible prose field", () => {
    const input = { ...finding(), title: "<script>danger</script>", evidence: ["</details><script>danger</script>"], risk: "<img src=x>", principle: "<script>danger</script>" };
    for (const output of [findingBody(input), findingBodyHtml(input)]) {
      expect(output).not.toContain("<script>");
      expect(output).not.toContain("<img src=x>");
      expect(output).toContain("&lt;script&gt;");
    }
  });

  test("material findings request changes regardless of GitHub enforcement", () => {
    for (const blocking of [false, true]) expect(reviewResultBody(report([finding()]), { blocking, profile: "balanced" })).toContain("Slop Sheriff: changes needed");
    expect(reviewResultBody(report([]))).toContain("Slop Sheriff: clear");
    expect(reviewResultBody(report([finding("IMPROVEMENT")]))).toContain("1 optional finding");
    expect(reviewResultBody(report([finding("NITPICK")]))).toContain("Slop Sheriff: clear");
    const incomplete = report([]); incomplete.coverage.unreached.push("Required runtime probe did not run");
    expect(reviewResultBody(incomplete)).toContain("review incomplete");
  });

  test("only actionable unrelated concerns appear in expandable summary details", () => {
    const input = report([finding()]);
    input.limitations = ["test-health: no coverage", "out-of-scope"];
    input.coverage.skippedAxes = [{ name: "discoverability", reason: "No public content changed" }];
    input.actionSummary = "Traced the publication path and found the missing code location.";
    input.additionalConcerns = [{ title: "An older export drops metadata", location: { path: "src/export.ts", line: 12, symbol: null }, consequence: "Older consumers lose recorded metadata.", recommendedChange: "Preserve the exported fields." }];
    const body = reviewResultBody(input);
    expect(body).toContain("<summary>Additional concerns</summary>");
    expect(body).toContain("An older export drops metadata");
    expect(body).toContain("src/export");
    expect(body).not.toContain("discoverability");
    expect(body).not.toContain("test-health");
    expect(body).toContain("Traced the publication path");
  });

  test("dismissal removes outstanding count distinctly from a verified fix", () => {
    const dismissed = { ...finding(), status: "deferred" as const, dismissal: { reason: "The maintainer accepted this tradeoff", actor: "maintainer", head: "a".repeat(40), commentId: "123" } };
    const body = reviewResultBody(report([dismissed]));
    expect(body).toContain("Slop Sheriff: clear");
    expect(body).toContain("Accepted dismissals");
    expect(body).toContain("not a verified fix");
  });

  test("native review submission never announces completion before delivery", () => {
    const body = nativeReviewBody(report([finding()]));
    expect(body).toStartWith("## 💬 Slop Sheriff: review findings");
    expect(body).not.toContain("Slop Sheriff: clear");
    expect(body).not.toContain("Slop Sheriff: changes needed");
  });

  test("targets the exact head-side diff line and falls back to the file", () => {
    const files = [
      {
        filename: "src/review.ts",
        status: "modified",
        patch: "@@ -10,3 +10,3 @@\n context\n-old\n+new\n context",
      },
    ];
    expect(reviewCommentLocation(finding(), files)).toEqual({
      line: 11,
      side: "RIGHT",
      subjectType: "line",
    });
    expect(
      reviewCommentLocation(
        { ...finding(), location: { ...finding().location, line: 50 } },
        files,
      ),
    ).toEqual({ subjectType: "file" });
    expect(findingBody(finding(), "file")).toContain(
      "Reported location: `src/review.ts`, line 11",
    );
  });

  test("uses the left side for a finding on a deleted line", () => {
    expect(
      reviewCommentLocation(finding(), [
        {
          filename: "src/review.ts",
          status: "removed",
          patch: "@@ -10,2 +0,0 @@\n-old\n-removed",
        },
      ]),
    ).toEqual({ line: 11, side: "LEFT", subjectType: "line" });
  });

  test("does not move a head-side finding onto a deleted line", () => {
    expect(
      reviewCommentLocation(finding(), [
        {
          filename: "src/review.ts",
          status: "modified",
          patch: "@@ -10,2 +10 @@\n context\n-removed",
        },
      ]),
    ).toEqual({ subjectType: "file" });
  });
});
