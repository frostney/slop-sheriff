import { findingIsOutstanding, type ReviewFinding, type ReviewReport } from "../review/findings";
import type { ReviewConfig, ReviewProfile } from "../config/review-config";
import { findingIdentity } from "../review/finding-identity";
import {
  deterministicFindingPresentation,
  renderPlainText,
  escapeHtml,
  type RichText,
  renderSafeRichText,
} from "./deterministic-presentation";

const severityEmoji: Readonly<Record<ReviewFinding["severity"], string>> = {
  BLOCKING: "🚨",
  IMPORTANT: "⚠️",
  IMPROVEMENT: "💡",
  NITPICK: "🧹",
};

const profileSeverities: Readonly<
  Record<ReviewProfile, ReadonlySet<ReviewFinding["severity"]>>
> = {
  focused: new Set(["BLOCKING", "IMPORTANT"]),
  balanced: new Set(["BLOCKING", "IMPORTANT", "IMPROVEMENT"]),
  thorough: new Set(["BLOCKING", "IMPORTANT", "IMPROVEMENT", "NITPICK"]),
};

export function findingIsPublished(
  finding: ReviewFinding,
  profile: ReviewProfile,
): boolean {
  return findingIsOutstanding(finding) && profileSeverities[profile].has(finding.severity);
}

export function publishedFindings(
  report: ReviewReport,
  profile: ReviewProfile,
): ReviewFinding[] {
  return report.findings.filter((finding) => findingIsPublished(finding, profile));
}

export function reviewFindingCountSummary(
  report: ReviewReport,
  profile: ReviewProfile = "balanced",
): string {
  const active = report.findings.filter((finding) => findingIsOutstanding(finding));
  const count = (severity: ReviewFinding["severity"]) =>
    active.filter((finding) => finding.severity === severity).length;
  const improvements = count("IMPROVEMENT");
  const nitpicks = count("NITPICK");
  const profileSummary = (
    emoji: string,
    count: number,
    singular: string,
    plural: string,
    severity: ReviewFinding["severity"],
  ) =>
    !profileSeverities[profile].has(severity) && count > 0
      ? `${emoji} ${count} ${count === 1 ? singular : plural} detected · hidden by ${profile} profile`
      : `${emoji} ${count} ${count === 1 ? singular : plural}`;
  return [
    `🚨 ${count("BLOCKING")} blocking`,
    `⚠️ ${count("IMPORTANT")} important`,
    profileSummary("💡", improvements, "improvement", "improvements", "IMPROVEMENT"),
    profileSummary("🧹", nitpicks, "nitpick", "nitpicks", "NITPICK"),
  ].join(" · ");
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** Count rendered prose, including labels and code, without counting Markdown syntax. */
export function findingWordCount(value: string): number {
  return value.trim().split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

interface InlineFindingPresentation {
  readonly marker: string;
  readonly introduction: string | undefined;
  readonly principle: string | undefined;
  readonly risk: string | undefined;
  readonly remedy: RichText;
  readonly title: RichText;
  readonly severity: string;
  readonly label: string;
  readonly location: string | null;
  readonly evidence: readonly RichText[];
  readonly impact: string;
}

function inlineFindingPresentation(
  finding: ReviewFinding,
  placement: "file" | "line",
  _personality: boolean,
): InlineFindingPresentation {
  const presentation = deterministicFindingPresentation(finding);
  const identity = findingIdentity(finding);
  const location = placement === "file"
    ? `Reported location: ${finding.location.path}, line ${finding.location.line}`
    : null;
  const label = titleCase(finding.severity);
  const content = [
    finding.introduction ?? "", finding.title, label, location ?? "",
    "Evidence and recommended change", ...finding.evidence, finding.principle ?? "", finding.remedy,
    `Impact: ${presentation.impactSummary}`, finding.risk ? `Risk: ${finding.risk}` : "",
  ].join(" ");
  const words = findingWordCount(content);
  if (finding.introduction && (findingWordCount(finding.introduction) < 25 || findingWordCount(finding.introduction) > 45)) {
    throw new Error(`Finding ${finding.id} introduction must contain 25 to 45 words.`);
  }
  if (content.includes("\u2014")) throw new Error(`Finding ${finding.id} prose must not contain em dashes.`);
  if (words > 200) {
    throw new Error(`Finding ${finding.id} needs concise wording: ${words} words exceeds the 200-word inline limit. Rewrite the introduction, evidence, principle, remedy, risk, and impact summary without dropping concrete evidence.`);
  }
  return {
    marker: `<!-- known-good-review:finding:v2:${identity}:${finding.id} -->`,
    introduction: finding.introduction,
    principle: finding.principle,
    risk: finding.risk,
    remedy: presentation.remedy,
    title: presentation.title,
    severity: severityEmoji[finding.severity],
    label,
    location,
    evidence: presentation.evidence,
    impact: presentation.impactSummary,
  };
}

export function validateFindingPresentation(
  finding: ReviewFinding,
  placement: "file" | "line" = "file",
  personality = true,
): void {
  inlineFindingPresentation(finding, placement, personality);
}

export function findingBody(
  finding: ReviewFinding,
  placement: "file" | "line" = "line",
  personality = true,
): string {
  const presentation = inlineFindingPresentation(finding, placement, personality);
  return [
    presentation.marker,
    `### ${presentation.severity} ${renderSafeRichText(presentation.title)}`,
    "",
    `**${presentation.label}**`,
    ...(presentation.location ? ["", `Reported location: \`${finding.location.path}\`, line ${finding.location.line}`] : []),
    "",
    ...(presentation.introduction ? [renderPlainText(presentation.introduction), ""] : []),
    "<details>", "<summary>Evidence and recommended change</summary>", "",
    ...presentation.evidence.map(renderSafeRichText),
    ...(presentation.principle ? ["", renderPlainText(presentation.principle)] : []),
    "", renderSafeRichText(presentation.remedy), "", "</details>", "",
    `Impact: ${renderPlainText(presentation.impact)}`,
    ...(presentation.risk ? ["", `Risk: ${renderPlainText(presentation.risk)}`] : []),
  ].join("\n");
}

function richTextHtml(parts: RichText): string {
  return parts.map((part) => part.kind === "code"
    ? `<code>${escapeHtml(part.value)}</code>`
    : escapeHtml(part.value)).join("");
}

/** Website and GitHub comments share content, limits, and ordering. Voice is authored before rendering. */
export function findingBodyHtml(
  finding: ReviewFinding,
  placement: "file" | "line" = "line",
  personality = true,
): string {
  const presentation = inlineFindingPresentation(finding, placement, personality);
  return [
    `<h3>${presentation.severity} ${richTextHtml(presentation.title)}</h3>`,
    `<p><strong>${escapeHtml(presentation.label)}</strong></p>`,
    ...(presentation.location ? [`<p>${escapeHtml(presentation.location)}</p>`] : []),
    ...(presentation.introduction ? [`<p>${escapeHtml(presentation.introduction)}</p>`] : []),
    "<details><summary>Evidence and recommended change</summary>",
    ...presentation.evidence.map((evidence) => `<p>${richTextHtml(evidence)}</p>`),
    ...(presentation.principle ? [`<p>${escapeHtml(presentation.principle)}</p>`] : []),
    `<p>${richTextHtml(presentation.remedy)}</p></details>`,
    `<p>Impact: ${escapeHtml(presentation.impact)}</p>`,
    ...(presentation.risk ? [`<p>Risk: ${escapeHtml(presentation.risk)}</p>`] : []),
  ].join("\n");
}

type PresentationConfig = Pick<ReviewConfig, "blocking" | "profile"> & {
  readonly personality?: boolean | undefined;
};
const defaultPresentationConfig: PresentationConfig = { blocking: false, profile: "balanced" };

function additionalConcernLines(report: ReviewReport): string[] {
  if (!report.additionalConcerns?.length) return [];
  return ["", "<details>", "<summary>Additional concerns</summary>", "",
    ...report.additionalConcerns.map((concern) => `- **${renderPlainText(concern.title)}** (${renderPlainText(concern.location.path)}, line ${concern.location.line}): ${renderPlainText(concern.consequence)} ${renderPlainText(concern.recommendedChange)}`),
    "", "</details>"];
}

function reviewSummaryLines(report: ReviewReport): string[] {
  const active = report.findings.filter((finding) => findingIsOutstanding(finding));
  const optional = active.filter((finding) => finding.severity === "IMPROVEMENT" || finding.severity === "NITPICK").length;
  const required = active.length - optional;
  const status = active.length === 0 ? "No outstanding findings."
    : [required ? `${required} ${required === 1 ? "finding requires" : "findings require"} changes.` : "No findings require changes.", optional ? `${optional} optional ${optional === 1 ? "finding remains" : "findings remain"}.` : ""].filter(Boolean).join(" ");
  return [
    status, "",
    ...(report.actionSummary ? [renderPlainText(report.actionSummary), ""] : []),
    ...additionalConcernLines(report),
    ...(report.findings.some((finding) => finding.dismissal) ? ["", "<details>", "<summary>Accepted dismissals</summary>", "", ...report.findings.filter((finding) => finding.dismissal).map((finding) => `- ${renderPlainText(finding.title)}: ${renderPlainText(finding.dismissal!.reason)} (accepted by ${renderPlainText(finding.dismissal!.actor)}; not a verified fix).`), "", "</details>"] : []),
  ];
}

/** Native submission precedes durable thread reconciliation, so it cannot claim completion. */
export function nativeReviewBody(
  _report: ReviewReport,
  _config: PresentationConfig = defaultPresentationConfig,
): string {
  return "## 💬 Slop Sheriff: review findings\n\nFindings are attached to the affected code.";
}

export function reviewResultBody(
  report: ReviewReport,
  _config: PresentationConfig = defaultPresentationConfig,
): string {
  const active = report.findings.filter((finding) => findingIsOutstanding(finding));
  const hasBlocking = active.some(
    (finding) => finding.severity === "BLOCKING" || finding.severity === "IMPORTANT",
  );
  const incomplete = report.coverage.unreached.length > 0;
  const heading = incomplete
    ? "## ⚠️ Slop Sheriff: review incomplete"
    : hasBlocking ? "## 🛑 Slop Sheriff: changes needed"
    : "## ✅ Slop Sheriff: clear to merge";
  return [heading, "", ...reviewSummaryLines(report)].join("\n");
}

export function reviewProgressBody(
  status: "completed" | "debouncing" | "failed" | "never" | "running",
  _personality = true,
): string {
  if (status === "debouncing") {
    return [
      "## ⏳ Slop Sheriff: reviewing current changes",
      "",
      "The review is queued for its debounce window.",
    ].join("\n");
  }
  if (status === "running") {
    return [
      "## ⏳ Slop Sheriff: reviewing current changes",
      "",
      "The current revision is being reviewed.",
    ].join("\n");
  }
  if (status === "failed" || status === "completed") {
    return [
      "## ⚠️ Slop Sheriff: review incomplete",
      "",
      "The review did not complete. See the Check Run for details.",
    ].join("\n");
  }
  return [
    "## ⏸️ Slop Sheriff: not started",
    "",
    "No review has started yet.",
  ].join("\n");
}
