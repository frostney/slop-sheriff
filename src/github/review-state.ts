import { z } from "zod";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { reviewProfiles } from "../config/review-config";
import { reviewReportSchema } from "../review/findings";
import { reviewFailureEnvelopeSchema } from "../review/recovery";
import { reportAssemblyIdentitySchema, ReviewReportValidationError } from "../review/report-assembly";
import {
  reviewProgressBody,
  reviewResultBody,
} from "./review-presentation";

const stateMarker = "known-good-review:state";

export const reviewStateSchema = z.object({
  schemaVersion: z.literal(2),
  app: z.literal("known-good-review"),
  pullRequest: z.number().int().positive(),
  initialFullStatus: z.enum([
    "never",
    "debouncing",
    "running",
    "completed",
    "failed",
  ]),
  publication: z
    .object({
      blocking: z.boolean(),
      profile: z.enum(reviewProfiles),
      personality: z.boolean().optional(),
    })
    .optional(),
  baseline: z
    .object({
      head: z.string().min(1),
      patchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      findingsArtifactUrl: z.url(),
      files: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)),
      report: reviewReportSchema,
      findingThreadIdentities: z.record(z.string().regex(/^CR-[1-9]\d*$/), z.string().regex(/^[a-f0-9]{64}$/)).optional(),
      findingRuntimeRequirements: z.record(z.string().regex(/^CR-[1-9]\d*$/), z.boolean()).optional(),
    })
    .nullable(),
  pendingPublication: z
    .object({
      identity: reportAssemblyIdentitySchema,
      report: reviewReportSchema,
      stagedAt: z.iso.datetime(),
    })
    .optional(),
  failure: reviewFailureEnvelopeSchema.optional(),
  updatedAt: z.iso.datetime(),
});

export type ReviewState = z.infer<typeof reviewStateSchema>;

export const reviewStateCommentLimit = 65_000;
export const maxReviewStateBytes = 8 * 1024 * 1024;
const partSize = 60_000;
const maxParts = 64;
const partMarker = "known-good-review:state-part:v1";
const attachmentLabel = "Review state attachment.";

function visibleState(parsed: ReviewState): string {
  return parsed.failure
    ? reviewProgressBody("failed", parsed.publication?.personality)
    : parsed.initialFullStatus === "completed" && parsed.baseline
      ? reviewResultBody(
          parsed.baseline.report,
          parsed.publication ?? { blocking: false, profile: "balanced" },
        )
      : reviewProgressBody(parsed.initialFullStatus, parsed.publication?.personality);
}

function stateComment(state: ReviewState, payload: string): string {
  return `${visibleState(state)}\n\n<!-- ${stateMarker}\n${payload}\n-->`;
}

function digest(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

export function encodeReviewState(state: ReviewState): string {
  const parsed = reviewStateSchema.parse(state);
  return stateComment(parsed, Buffer.from(JSON.stringify(parsed)).toString("base64url"));
}

/** Immutable parts are saved before the summary pointer, preserving the old baseline on failure. */
export function prepareReviewStateComments(state: ReviewState): {
  readonly body: string;
  readonly parts: readonly string[];
} {
  const parsed = reviewStateSchema.parse(state);
  const json = JSON.stringify(parsed);
  if (Buffer.byteLength(json, "utf8") > maxReviewStateBytes) {
    throw new ReviewReportValidationError(
      [{ code: "too_big", path: ["report"] }],
      "The review state exceeds its 8 MiB storage bound; shorten the report before retrying",
    );
  }
  const plain = stateComment(parsed, Buffer.from(json).toString("base64url"));
  if (Buffer.byteLength(plain, "utf8") <= reviewStateCommentLimit) return { body: plain, parts: [] };
  const compressed = gzipSync(json).toString("base64url");
  const inline = stateComment(parsed, `gz:${compressed}`);
  if (Buffer.byteLength(inline, "utf8") <= reviewStateCommentLimit) return { body: inline, parts: [] };
  const count = Math.ceil(compressed.length / partSize);
  if (count > maxParts) {
    throw new ReviewReportValidationError(
      [{ code: "too_big", path: ["report"] }],
      "The compressed review state exceeds its attachment bound; shorten the report before retrying",
    );
  }
  const hash = digest(compressed);
  return {
    body: stateComment(parsed, `gz-parts:${hash}:${count}`),
    parts: Array.from({ length: count }, (_, index) =>
      `${attachmentLabel}\n\n<!-- ${partMarker}:${hash}:${index}:${count}\n${compressed.slice(index * partSize, (index + 1) * partSize)}\n-->`),
  };
}

function collectStateParts(payload: string, comments: readonly string[]): string | null {
  const manifest = /^gz-parts:([a-f0-9]{64}):([1-9]\d*)$/.exec(payload);
  if (!manifest?.[1] || !manifest[2]) return null;
  const count = Number(manifest[2]);
  if (count > maxParts) return null;
  const parts = new Map<number, string>();
  const pattern = new RegExp(`^${attachmentLabel.replace(".", "\\.")}\n\n<!-- ${partMarker}:${manifest[1]}:([0-9]+):${count}\n([A-Za-z0-9_-]{1,${partSize}})\n-->$`);
  for (const comment of comments) {
    const match = pattern.exec(comment);
    if (!match?.[1] || !match[2]) continue;
    const index = Number(match[1]);
    if (!Number.isSafeInteger(index) || index >= count || String(index) !== match[1]) return null;
    const previous = parts.get(index);
    if (previous !== undefined && previous !== match[2]) return null;
    parts.set(index, match[2]);
  }
  if (parts.size !== count) return null;
  const joined = Array.from({ length: count }, (_, index) => parts.get(index)).join("");
  return digest(joined) === manifest[1] ? joined : null;
}

/** Callers must supply only comments belonging to the configured application bot. */
export function decodeReviewState(comment: string, parts: readonly string[] = []): ReviewState | null {
  if (!isReviewStateComment(comment)) return null;
  const match = comment.match(new RegExp(`<!-- ${stateMarker}\n([^\n]+)\n-->$`));
  if (!match?.[1]) return null;
  try {
    const payload = match[1];
    const compressed = payload.startsWith("gz-parts:")
      ? collectStateParts(payload, parts)
      : payload.startsWith("gz:") ? payload.slice(3) : null;
    if (payload.startsWith("gz") && compressed === null) return null;
    const encoded = compressed ?? payload;
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > Math.ceil(maxReviewStateBytes * 4 / 3)) return null;
    const bytes = Buffer.from(encoded, "base64url");
    const json = compressed === null ? bytes : gunzipSync(bytes, { maxOutputLength: maxReviewStateBytes });
    if (json.byteLength > maxReviewStateBytes) return null;
    return reviewStateSchema.parse(JSON.parse(json.toString("utf8")));
  } catch {
    return null;
  }
}

export function isReviewStateComment(comment: string): boolean {
  // Finding bodies can quote markers. Only application-authored state envelopes
  // begin with this heading (or the legacy marker-only form).
  return /^(?:## [^\n]*(?:Slop Sheriff|known-good-review):|<!-- known-good-review:state\n)/.test(comment)
    && comment.includes(`<!-- ${stateMarker}\n`);
}

export function pendingReviewState(input: {
  readonly publication?: { readonly blocking: boolean; readonly profile: "focused" | "balanced" | "thorough"; readonly personality?: boolean };
  readonly pullRequest: number;
  readonly status: "debouncing" | "running" | "failed";
}): ReviewState {
  return {
    schemaVersion: 2,
    app: "known-good-review",
    pullRequest: input.pullRequest,
    initialFullStatus: input.status,
    publication: input.publication ?? { blocking: false, profile: "balanced" },
    baseline: null,
    updatedAt: new Date().toISOString(),
  };
}
