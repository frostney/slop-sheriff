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

/**
 * Pins the fresh review session's channel state to the head the review was
 * accepted for, which is the head its checks were created on. Eve seeds a
 * comment-triggered session with no head and fills it in only after a
 * successful sandbox checkout, and a pull-request event carries the webhook's
 * head. The failure handler needs the accepted head even when the session dies
 * before checkout, and the checkout then uses that exact commit.
 */
export function withAcceptedReviewHead<TState>(
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
  // The channel state type is generic here; only its headSha is replaced.
  return { ...options, state: { ...state, headSha: head } } as ChannelSendOptions<TState>;
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
            ? { ...withAcceptedReviewHead(options), mode: "task" }
            : options,
        );
      },
    };
  };
}
