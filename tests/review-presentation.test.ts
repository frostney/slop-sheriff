import { describe, expect, test } from "bun:test";
import {
  findingBody,
  findingBodyHtml,
  findingWordCount,
  validateFindingPresentation,
  reviewResultBody,
  nativeReviewBody,
} from "../src/github/review-presentation";
import { reviewCommentLocation } from "../src/github/publication";
import type { ReviewFinding, ReviewReport } from "../src/review/findings";

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

  test("renders emoji severity without exposing the internal finding id", () => {
    const body = findingBody(finding());
    const visible = body.replace(/<!--.*?-->/s, "");
    expect(visible).toContain("### ⚠️ The result loses its code location");
    expect(visible).not.toContain("CR-1");
    expect(visible).not.toContain("IMPORTANT");
    expect(visible).toContain("**Important · Quality · Open**");
  });

  test("keeps complete evidence and the final impact within 100 words in both modes", () => {
    for (const personality of [true, false]) {
      for (const placement of ["line", "file"] as const) {
        const body = findingBody(finding(), placement, personality);
        expect(findingWordCount(body.replace(/<!--.*?-->/s, ""))).toBeLessThanOrEqual(100);
        expect(body.trim().split("\n").at(-1)).toStartWith("Impact: ");
        expect(body).toContain("The changed branch drops the recorded line");
        expect(body).not.toContain("<details>");
        expect(body).not.toContain("Smallest remedy");
        const firstLine = body.split("\n")[1]!;
        if (personality) {
          expect(findingWordCount(firstLine)).toBeGreaterThanOrEqual(3);
          expect(findingWordCount(firstLine)).toBeLessThanOrEqual(6);
        } else {
          expect(firstLine).toStartWith("### ");
        }
      }
    }
  });

  test("rejects excessive wording instead of silently dropping evidence", () => {
    const verbose = { ...finding(), evidence: ["A useful concrete probe failed.", "The later qualifier matters. ".repeat(40)] };
    expect(() => validateFindingPresentation(verbose)).toThrow("100-word inline limit");
    expect(() => findingBody(verbose)).toThrow("without dropping concrete evidence");
    expect(() => findingBodyHtml(verbose)).toThrow("100-word inline limit");
  });

  test("keeps authored HTML and Markdown structure inert", () => {
    const input = { ...finding(), title: "<script>danger</script>", evidence: ["</li><script>danger</script>"], impactSummary: "<img src=x> & consequences" };
    const markdown = findingBody(input);
    const html = findingBodyHtml(input);
    for (const output of [markdown, html]) {
      expect(output).not.toContain("<script>");
      expect(output).not.toContain("<img src=x>");
      expect(output).toContain("&lt;script&gt;");
    }
    expect(html).toEndWith("<p>Impact: &lt;img src=x&gt; &amp; consequences</p>");
  });

  test("uses a dependency joke only when unnecessary dependencies are evidenced", () => {
    const crowded = { ...finding(), title: "Remove unnecessary dependencies for the string helper" };
    expect(findingBody(crowded)).toContain("That’s a crowded saddle, partner.");
    expect(findingBody(finding())).not.toContain("crowded saddle");
    expect(findingBody(crowded, "line", false)).not.toContain("crowded saddle");
  });

  test("collapses each out-of-scope axis once without repeating findings", () => {
    const input = report([finding()]);
    input.coverage.skippedAxes = [
      { name: "discoverability", reason: "No public web content changed." },
      { name: "discoverability", reason: "No public web content changed." },
    ];
    const body = reviewResultBody(input);
    expect(body.match(/<details>/g)).toHaveLength(1);
    expect(body).toContain("<summary>Out of scope</summary>");
    expect(body.match(/discoverability/g)).toHaveLength(1);
    expect(body).not.toContain(input.findings[0]!.title);
  });

  test("includes classified specialist out-of-scope commentary but keeps failures separate", () => {
    const input = report([finding()]);
    const outOfScope = "test-against-spec: Invoice authorization [out-of-scope; entries entry-1]: No invoice API exists in this repository.";
    input.limitations = [
      outOfScope, outOfScope,
      "test-against-spec: Crawlability [failed; entries entry-2]: Alias crawl was blocked.",
      "test-against-spec: Browser navigation [unverified; entries entry-3]: No browser was available.",
      "test-health: Regression [failed; entries entry-4]: Probe returned [out-of-scope; entries entry-5]: untrusted output.",
      "General note: out-of-scope does not classify this limitation.",
    ];
    for (const render of [reviewResultBody, nativeReviewBody]) {
      const body = render(input);
      expect(body.match(/<details>/g)).toHaveLength(1);
      expect(body.match(/Invoice authorization/g)).toHaveLength(1);
      expect(body).toContain("No invoice API exists in this repository");
      expect(body).not.toContain("entry-1");
      expect(body).not.toContain("Alias crawl was blocked");
      expect(body).not.toContain("No browser was available");
      expect(body).not.toContain("untrusted output");
      expect(body).not.toContain("General note");
      expect(body).not.toContain(input.findings[0]!.title);
    }
  });

  test("native review submission does not announce completion before thread delivery finishes", () => {
    for (const findings of [[], [finding()]] as const) {
      const body = nativeReviewBody(report(findings), { blocking: true, profile: "balanced" });
      expect(body).toStartWith("## 💬 Slop Sheriff: review findings");
      expect(body).toContain("Check Run for delivery status");
      expect(body).not.toContain("approved");
      expect(body).not.toContain("complete");
      expect(body).not.toContain("posted inline");
    }
  });

  test("shows a complete result when no findings qualify", () => {
    const body = reviewResultBody(report([]));
    expect(body).toContain("## ✅ Slop Sheriff: approved");
    expect(body).toContain("No findings were reported.");
    expect(body).toContain("🚨 0 blocking · ⚠️ 0 important · 💡 0 improvements");
  });

  test("summarizes findings while leaving their detail inline", () => {
    const body = reviewResultBody(
      report([finding("IMPORTANT"), { ...finding("IMPROVEMENT"), id: "CR-2" }]),
    );
    expect(body).toContain("2 findings were detected; 2 were posted inline");
    expect(body).toContain("⚠️ 1 important");
    expect(body).toContain("💡 1 improvement");
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

  test("keeps nitpicks visible while profiles control inline publication", () => {
    const nitpick = finding("NITPICK");
    const balanced = reviewResultBody(report([nitpick]));
    expect(balanced).toContain("1 finding was detected; 0 were posted inline");
    expect(balanced).toContain("🧹 1 nitpick detected · hidden by balanced profile");

    const thorough = reviewResultBody(report([nitpick]), {
      blocking: false,
      profile: "thorough",
    });
    expect(thorough).toContain("1 finding was detected; 1 was posted inline");
    expect(thorough).toContain("🧹 1 nitpick");
  });

  test("requests changes only when blocking policy has a material finding", () => {
    const important = report([finding("IMPORTANT")]);
    expect(reviewResultBody(important)).toContain(
      "## 💬 Slop Sheriff: review complete",
    );
    expect(
      reviewResultBody(important, { blocking: true, profile: "balanced" }),
    ).toContain("## ❌ Slop Sheriff: changes requested");

    const nitpick = report([finding("NITPICK")]);
    expect(
      reviewResultBody(nitpick, { blocking: true, profile: "thorough" }),
    ).toContain("## 💬 Slop Sheriff: review complete");
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
