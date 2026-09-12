import { z } from "zod";
import { isReviewBotComment } from "./comment-identity";
import {
  changedEffectiveFiles,
  effectivePatchFileFingerprints,
  effectivePatchFingerprint,
  type PatchFile,
} from "../review/effective-patch";
import type { BaselineState, ReviewPlan } from "../review/lifecycle";
import { planReview } from "../review/lifecycle";
import type { ReviewReport } from "../review/findings";
import {
  decodeReviewState,
  isReviewStateComment,
  type ReviewState,
} from "./review-state";

export const pullRequestDetailsSchema = z.object({
  number: z.number().int().positive(),
  draft: z.boolean(),
  state: z.string(),
  base: z.object({ sha: z.string().min(1) }),
  head: z.object({ sha: z.string().min(1) }),
});

const pullRequestFileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().optional(),
  sha: z.string().min(1),
  status: z.string(),
  patch: z.string().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});

const issueCommentSchema = z.object({
  body: z.string().nullable().optional(),
  user: z.object({
    id: z.number().optional(),
    login: z.string().optional(),
    type: z.string().optional(),
  }).nullable().optional(),
});

export function parsePullRequestFiles(value: unknown): PatchFile[] {
  return z.array(pullRequestFileSchema).parse(value).map((file) => ({
    blobSha: file.sha,
    path: file.filename,
    previousPath: file.previous_filename ?? null,
    status:
      file.status === "removed"
        ? "deleted"
        : file.status === "renamed"
          ? "renamed"
          : file.status === "added"
            ? "added"
            : file.status === "copied"
              ? "copied"
              : "modified",
    patch: file.patch ?? null,
    ...(file.additions === undefined ? {} : { additions: file.additions }),
    ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
  }));
}

export function reviewStateFromComments(value: unknown):
  | { readonly kind: "absent" }
  | { readonly kind: "lost" }
  | { readonly kind: "valid"; readonly state: ReviewState } {
  const comments = z.array(issueCommentSchema).parse(value).filter(isReviewBotComment);
  const stateComments = comments.filter((comment) =>
    isReviewStateComment(comment.body ?? ""),
  );
  if (stateComments.length === 0) {
    const hasFindingEvidence = comments.some((comment) =>
      comment.body?.includes("<!-- known-good-review:finding:"),
    );
    return hasFindingEvidence ? { kind: "lost" } : { kind: "absent" };
  }
  const bodies = comments.map((comment) => comment.body ?? "");
  const decoded = stateComments
    .map((comment) => decodeReviewState(comment.body ?? "", bodies))
    .filter((state): state is ReviewState => state !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  return decoded ? { kind: "valid", state: decoded } : { kind: "lost" };
}

export interface PlannedDispatch {
  readonly changedFiles: readonly string[];
  readonly patchFingerprint?: string;
  readonly plan: ReviewPlan;
  readonly priorReport: ReviewReport | null;
}

export function planDispatch(input: {
  readonly action:
    | "closed"
    | "converted_to_draft"
    | "opened"
    | "ready_for_review"
    | "reopened"
    | "synchronize";
  readonly draft: boolean;
  readonly head: string;
  readonly manualFull?: boolean;
  readonly reviewPolicyDigest?: string;
  readonly manualFullAuthorized?: boolean;
  readonly patchFiles?: readonly PatchFile[];
  readonly state:
    | { readonly kind: "absent" }
    | { readonly kind: "lost" }
    | { readonly kind: "valid"; readonly state: ReviewState };
}): PlannedDispatch {
  const baseline: BaselineState =
    input.state.kind === "lost"
      ? { kind: "lost" }
      : input.state.kind === "valid"
        ? input.state.state.initialFullStatus === "completed" &&
          input.state.state.baseline
          ? {
              kind: "available",
              head: input.state.state.baseline.head,
              patchFingerprint:
                input.state.state.baseline.patchFingerprint,
            }
          : input.state.state.initialFullStatus === "failed"
            ? { kind: "lost" }
            : {
                kind: "none",
                initial:
                  input.state.state.initialFullStatus === "running"
                    ? "running"
                    : input.state.state.initialFullStatus === "debouncing"
                      ? "debouncing"
                      : "never",
              }
        : { kind: "none", initial: "never" };
  const patchFingerprint = input.patchFiles
    ? effectivePatchFingerprint(input.patchFiles)
    : undefined;
  let plan = planReview({
    action: input.action,
    baseline,
    draft: input.draft,
    head: input.head,
    ...(input.manualFull === undefined
      ? {}
      : { manualFull: input.manualFull }),
    ...(input.manualFullAuthorized === undefined
      ? {}
      : { manualFullAuthorized: input.manualFullAuthorized }),
    ...(patchFingerprint === undefined ? {} : { patchFingerprint }),
  });
  const priorBaseline =
    input.state.kind === "valid" ? input.state.state.baseline : null;
  if (input.reviewPolicyDigest && priorBaseline && priorBaseline.reviewPolicyDigest !== input.reviewPolicyDigest &&
      (plan.kind === "reuse" || plan.kind === "delta")) {
    plan = { kind: "full", delaySeconds: 0, reason: "initial", supersedesActiveReview: true };
  }
  const changedFiles =
    priorBaseline && input.patchFiles
      ? changedEffectiveFiles(
          priorBaseline.files,
          effectivePatchFileFingerprints(input.patchFiles),
        )
      : [];
  return {
    changedFiles,
    ...(patchFingerprint === undefined ? {} : { patchFingerprint }),
    plan,
    priorReport: priorBaseline?.report ?? null,
  };
}
