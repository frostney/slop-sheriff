import type { Octokit } from "@octokit/rest";
import { boundedText } from "./deterministic-presentation";
import { concludeRunningChecks } from "./publication";

/** The `session.failed` event data Eve passes to a channel. */
export interface FailedSessionEvent {
  readonly code: string;
  readonly details?: unknown;
  readonly message: string;
  readonly sessionId: string;
}

/** The persisted GitHub channel state of the failed session. */
export interface FailedSessionTarget {
  readonly headSha: string | null;
  readonly installationId: number | null;
  readonly owner: string;
  readonly repo: string;
  /** The review attempt the session runs (see withAcceptedReviewState). */
  readonly reviewAttempt: string | null;
}

function detailString(details: unknown, key: "errorId" | "name"): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const value = (details as Readonly<Record<string, unknown>>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * The reason recorded on the concluded checks and the failure comment. It
 * shows no more of the error than Eve's own failure comment did: the error
 * class, at most 160 characters of its message, and its error id. Every field
 * is bounded, so the reason always fits a check summary and a comment.
 */
export function failedSessionReason(event: FailedSessionEvent): string {
  const name = boundedText(detailString(event.details, "name") ?? event.code, 64);
  const message = boundedText(event.message, 160);
  const id = detailString(event.details, "errorId");
  return [
    `The review session stopped before it could publish a verdict (${name}${message ? `: ${message}` : ""}).`,
    ...id ? [`Error id: ${boundedText(id, 80)}`] : [],
    "",
    "A collaborator with write access can comment `@slop-sheriff full review` to run the review again.",
  ].join("\n");
}

/**
 * Eve emits `session.failed` without `turn.failed` when a durable step
 * exhausts its retries, so the telemetry hook that concludes checks on
 * `turn.failed` never runs. This channel handler closes the gap: it tries to
 * conclude every review check the session's attempt still owns on its head,
 * logs any update GitHub rejects, and then posts the failure comment either way.
 */
export async function concludeFailedSession(input: {
  readonly event: FailedSessionEvent;
  readonly octokitFor: (installationId: number) => Octokit;
  readonly postComment: (body: string) => Promise<unknown>;
  readonly target: FailedSessionTarget;
}): Promise<void> {
  const reason = failedSessionReason(input.event);
  let concluded = 0;
  try {
    if (input.target.installationId === null) {
      throw new Error("The failed session has no GitHub installation");
    }
    // A review session's state holds the head its checks were created on and
    // the attempt that owns them (see withAcceptedReviewState). Another
    // session's head may differ, so the pull request's current head is never
    // used in its place, and runs another attempt took over are left alone.
    const headSha = input.target.headSha;
    if (headSha === null) throw new Error("The failed session has no accepted head");
    concluded = await concludeRunningChecks({
      attempt: input.target.reviewAttempt,
      context: { headSha, owner: input.target.owner, repo: input.target.repo },
      message: reason,
      octokit: input.octokitFor(input.target.installationId),
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "known-good-review.session_failure.checks_failed",
      sessionId: input.event.sessionId,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    }));
  }
  console.info(JSON.stringify({
    event: "known-good-review.session_failure.concluded",
    sessionId: input.event.sessionId,
    code: input.event.code,
    concludedChecks: concluded,
  }));
  await input.postComment(reason);
}
