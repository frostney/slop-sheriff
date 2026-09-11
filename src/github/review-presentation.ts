import type { ReviewFinding, ReviewReport } from "../review/findings";
import type { ReviewConfig, ReviewProfile } from "../config/review-config";
import { findingIdentity } from "../review/finding-identity";
import { isReviewAxis } from "../review/axes";
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
  return finding.status !== "fixed" && profileSeverities[profile].has(finding.severity);
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
  const active = report.findings.filter((finding) => finding.status !== "fixed");
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

const cowboyOpeners = [
  "Hold up there, partner.",
  "One snag on the trail.",
  "Something’s rattling in this wagon.",
  "This trail needs attention.",
] as const;

/** Count rendered prose, including labels and code, without counting Markdown syntax. */
export function findingWordCount(value: string): number {
  return value.trim().split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

interface InlineFindingPresentation {
  readonly marker: string;
  readonly opener: string | null;
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
  personality: boolean,
): InlineFindingPresentation {
  const presentation = deterministicFindingPresentation(finding);
  const identity = findingIdentity(finding);
  const dependencyExcess = /\b(?:unnecessary|redundant|unused|excessive)\b[^.]{0,60}\b(?:dependencies|packages)\b/iu
    .test([finding.title, ...finding.evidence].join(" "));
  const opener = !personality ? null : dependencyExcess
    ? "That’s a crowded saddle, partner."
    : cowboyOpeners[Number.parseInt(identity.slice(0, 8), 16) % cowboyOpeners.length]!;
  const location = placement === "file"
    ? `Reported location: ${finding.location.path}, line ${finding.location.line}`
    : null;
  const label = `${titleCase(finding.severity)} · ${titleCase(finding.category)} · ${titleCase(finding.status)}`;
  const content = [
    opener ?? "", finding.title, label, location ?? "",
    ...finding.evidence, `Impact: ${presentation.impactSummary}`,
  ].join(" ");
  const words = findingWordCount(content);
  if (words > 100) {
    throw new Error(`Finding ${finding.id} needs concise wording: ${words} words exceeds the 100-word inline limit. Rewrite the title, evidence, and impact summary without dropping concrete evidence.`);
  }
  return {
    marker: `<!-- known-good-review:finding:v2:${identity}:${finding.id} -->`,
    opener,
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
    ...(presentation.opener ? [presentation.opener, ""] : []),
    `### ${presentation.severity} ${renderSafeRichText(presentation.title)}`,
    "",
    `**${presentation.label}**`,
    ...(presentation.location ? ["", `Reported location: \`${finding.location.path}\`, line ${finding.location.line}`] : []),
    "",
    presentation.evidence.map((evidence) => `- ${renderSafeRichText(evidence)}`).join("\n"),
    "",
    `Impact: ${renderPlainText(presentation.impact)}`,
  ].join("\n");
}

function richTextHtml(parts: RichText): string {
  return parts.map((part) => part.kind === "code"
    ? `<code>${escapeHtml(part.value)}</code>`
    : escapeHtml(part.value)).join("");
}

/** Website and GitHub comments share the same content, limits, and ordering. */
export function findingBodyHtml(
  finding: ReviewFinding,
  placement: "file" | "line" = "line",
  personality = true,
): string {
  const presentation = inlineFindingPresentation(finding, placement, personality);
  return [
    ...(presentation.opener ? [`<p>${escapeHtml(presentation.opener)}</p>`] : []),
    `<h3>${presentation.severity} ${richTextHtml(presentation.title)}</h3>`,
    `<p><strong>${escapeHtml(presentation.label)}</strong></p>`,
    ...(presentation.location ? [`<p>${escapeHtml(presentation.location)}</p>`] : []),
    `<ul>${presentation.evidence.map((evidence) => `<li>${richTextHtml(evidence)}</li>`).join("")}</ul>`,
    `<p>Impact: ${escapeHtml(presentation.impact)}</p>`,
  ].join("\n");
}

type PresentationConfig = Pick<ReviewConfig, "blocking" | "profile"> & {
  readonly personality?: boolean | undefined;
};
const defaultPresentationConfig: PresentationConfig = { blocking: false, profile: "balanced" };

function outOfScopeLines(report: ReviewReport): string[] {
  const commentary = new Map<string, Set<string>>();
  const add = (axis: string, reason: string) => {
    const reasons = commentary.get(axis) ?? new Set<string>();
    reasons.add(reason);
    commentary.set(axis, reasons);
  };
  for (const axis of report.coverage.skippedAxes) add(axis.name, axis.reason);
  for (const limitation of report.limitations) {
    // Match the first classification emitted by retainSpecialistEvidence. A failed
    // check that merely mentions out-of-scope text in its observation stays a failure.
    const classified = /^([^:\n]+): ([\s\S]*?) \[(passed|failed|unverified|out-of-scope); entries [^\]\n]*\]: ([\s\S]*)$/u.exec(limitation);
    if (!classified || classified[3] !== "out-of-scope" || !isReviewAxis(classified[1]!)) continue;
    add(classified[1]!, `${classified[2]}: ${classified[4]}`);
  }
  if (commentary.size === 0) return [];
  return [
    "", "<details>", "<summary>Out of scope</summary>", "",
    ...[...commentary].map(([axis, reasons]) =>
      `- ${renderPlainText(axis)}: ${[...reasons].map(renderPlainText).join("; ")}`),
    "", "</details>",
  ];
}

function reviewSummaryLines(report: ReviewReport, config: PresentationConfig, delivered: boolean): string[] {
  const active = report.findings.filter((finding) => finding.status !== "fixed");
  const published = publishedFindings(report, config.profile);
  const result = active.length === 0
    ? "No findings were reported."
    : `${active.length} ${active.length === 1 ? "finding was" : "findings were"} detected; ${published.length} ${published.length === 1 ? "was" : "were"} ${delivered ? "posted inline" : "selected for inline publication"} by the ${config.profile} profile.`;
  return [
    result, "", reviewFindingCountSummary(report, config.profile), "",
    delivered
      ? "See the Check Run for review coverage and limitations."
      : "See the Check Run for delivery status, review coverage, and limitations.",
    ...outOfScopeLines(report),
  ];
}

/** Native submission precedes durable thread reconciliation, so it cannot claim completion. */
export function nativeReviewBody(
  report: ReviewReport,
  config: PresentationConfig = defaultPresentationConfig,
): string {
  return ["## 💬 Slop Sheriff: review findings", "", ...reviewSummaryLines(report, config, false)].join("\n");
}

export function reviewResultBody(
  report: ReviewReport,
  config: PresentationConfig = defaultPresentationConfig,
): string {
  const active = report.findings.filter((finding) => finding.status !== "fixed");
  const hasBlocking = active.some(
    (finding) => finding.severity === "BLOCKING" || finding.severity === "IMPORTANT",
  );
  const heading = config.blocking && hasBlocking
    ? "## ❌ Slop Sheriff: changes requested"
    : active.length === 0
      ? "## ✅ Slop Sheriff: approved"
      : "## 💬 Slop Sheriff: review complete";
  return [
    heading, "",
    ...(config.personality === false ? [] : ["Patrol complete.", ""]),
    ...reviewSummaryLines(report, config, true),
  ].join("\n");
}

export function reviewProgressBody(
  status: "completed" | "debouncing" | "failed" | "never" | "running",
  personality = true,
): string {
  if (status === "debouncing") {
    return [
      "## ⏳ Slop Sheriff: accepted",
      "",
      "The review is queued for its debounce window.",
    ].join("\n");
  }
  if (status === "running") {
    return [
      "## ⏳ Slop Sheriff: in progress",
      "",
      personality ? "The sheriff is on patrol. Review in progress." : "The review is currently running.",
    ].join("\n");
  }
  if (status === "failed" || status === "completed") {
    return [
      "## ❌ Slop Sheriff: review incomplete",
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
