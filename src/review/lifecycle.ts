export type PullRequestAction =
  | "closed"
  | "converted_to_draft"
  | "opened"
  | "ready_for_review"
  | "reopened"
  | "synchronize";

export type BaselineState =
  | {
      readonly kind: "none";
      readonly initial: "debouncing" | "never" | "running";
    }
  | {
      readonly kind: "available";
      readonly head: string;
      readonly patchFingerprint: string;
    }
  | { readonly kind: "lost" };

export interface ReviewEvent {
  readonly action: PullRequestAction;
  readonly baseline: BaselineState;
  readonly draft: boolean;
  readonly head: string;
  readonly manualFull?: boolean;
  readonly manualFullAuthorized?: boolean;
  readonly patchFingerprint?: string;
}

export type ReviewPlan =
  | { readonly kind: "ignore"; readonly reason: string }
  | { readonly kind: "cancel"; readonly reason: "draft" }
  | { readonly kind: "cleanup"; readonly reason: "closed-or-merged" }
  | {
      readonly kind: "fail-closed";
      readonly reason: "lost-baseline" | "unauthorized-manual-full";
    }
  | {
      readonly kind: "full";
      readonly delaySeconds: 0 | 600;
      readonly reason: "initial" | "manual";
      readonly supersedesActiveReview: boolean;
    }
  | { readonly kind: "delta"; readonly revalidatePriorFindings: true };

export function planReview(event: ReviewEvent): ReviewPlan {
  if (event.action === "closed") {
    return { kind: "cleanup", reason: "closed-or-merged" };
  }
  if (event.action === "converted_to_draft" || event.draft) {
    return { kind: "cancel", reason: "draft" };
  }
  if (event.manualFull) {
    return event.manualFullAuthorized
      ? {
          kind: "full",
          delaySeconds: 0,
          reason: "manual",
          supersedesActiveReview: true,
        }
      : { kind: "fail-closed", reason: "unauthorized-manual-full" };
  }
  if (event.baseline.kind === "lost") {
    return { kind: "fail-closed", reason: "lost-baseline" };
  }
  if (event.baseline.kind === "none") {
    const immediate =
      event.action === "ready_for_review" || event.baseline.initial === "running";
    return {
      kind: "full",
      delaySeconds: immediate ? 0 : 600,
      reason: "initial",
      supersedesActiveReview: event.baseline.initial !== "never",
    };
  }
  if (event.patchFingerprint === undefined) {
    return { kind: "fail-closed", reason: "lost-baseline" };
  }
  // An unchanged diff is not proof that supporting base code or requirements
  // stayed valid. The persistent work planner verifies semantic dependencies.
  return { kind: "delta", revalidatePriorFindings: true };
}
