import type { ChannelFrom, ChannelSendOptions } from "eve/channels";
import type { SessionAuthContext } from "eve/context";
import { reviewContextAttributes } from "./trusted-context";

export function startsFreshReviewSession(
  auth: SessionAuthContext | null,
): boolean {
  const attributes = auth?.attributes ?? {};
  if (
    attributes[reviewContextAttributes.event] === "review-control-response"
  ) {
    return false;
  }
  const rawPlan = attributes[reviewContextAttributes.plan];
  if (typeof rawPlan !== "string") return false;
  try {
    const plan = JSON.parse(rawPlan) as { kind?: string };
    return plan.kind === "full" || plan.kind === "delta";
  } catch {
    return false;
  }
}

/** Channel-state field naming the review attempt a session runs. */
export const reviewAttemptStateKey = "slopSheriffReviewAttempt";

/**
 * The review attempt a dispatch accepts: its GitHub delivery id, which Eve's
 * `defaultGitHubAuth` records on the session auth. Both the running check's
 * owner marker and the session's channel state derive from this.
 */
export function reviewAttemptFromAuth(auth: SessionAuthContext | null | undefined): string | null {
  const attempt = auth?.attributes.delivery_id;
  return typeof attempt === "string" && attempt.length > 0 ? attempt : null;
}

/** The review attempt recorded in a session's channel state, if any. */
export function reviewAttemptFromState(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const attempt = (state as Record<string, unknown>)[reviewAttemptStateKey];
  return typeof attempt === "string" && attempt.length > 0 ? attempt : null;
}

/**
 * Pins the fresh review session's channel state to the review it was accepted
 * for: the head its checks were created on, and the attempt (the dispatch's
 * GitHub delivery id) that owns those checks. Eve seeds a comment-triggered
 * session with no head and fills it in only after a successful sandbox
 * checkout, and a pull-request event carries the webhook's head. The failure
 * handler needs both even when the session dies before checkout, and the
 * checkout then uses that exact commit. Eve merges this state into the
 * session's channel state and keeps fields it does not know.
 */
export function withAcceptedReviewState<TState>(
  options: ChannelSendOptions<TState>,
): ChannelSendOptions<TState> {
  const head = options.auth?.attributes[reviewContextAttributes.headSha];
  if (typeof head !== "string" || head.length === 0 || !("state" in options)) {
    return options;
  }
  const state: unknown = options.state;
  if (typeof state !== "object" || state === null || !("headSha" in state)) {
    return options;
  }
  const attempt = reviewAttemptFromAuth(options.auth);
  // The channel state type is generic here; only these fields are replaced.
  return {
    ...options,
    state: {
      ...state,
      headSha: head,
      ...attempt === null ? {} : { [reviewAttemptStateKey]: attempt },
    },
  } as ChannelSendOptions<TState>;
}

export function withFreshReviewSessions<TState>(
  from: ChannelFrom<TState>,
): ChannelFrom<TState> {
  return (address) => {
    const current = from(address);
    return {
      cancel: (options) => current.cancel(options),
      clear: () => current.clear(),
      compact: () => current.compact(),
      reset: (options) => current.reset(options),
      respond: (responses, options) => current.respond(responses, options),
      send: async (message, options) => {
        const freshReview = startsFreshReviewSession(options.auth);
        if (freshReview) {
          await current.reset({ reason: "new review dispatch" });
        }
        return from(address).send(
          message,
          freshReview
            ? { ...withAcceptedReviewState(options), mode: "task" }
            : options,
        );
      },
    };
  };
}
