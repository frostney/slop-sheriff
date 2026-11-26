import type { Octokit } from "@octokit/rest";
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
}

function displayLimit(value: string, limit = 160): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1).trimEnd()}…`;
}

function errorName(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const name = (details as { readonly name?: unknown }).name;
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
}

function errorId(details: unknown): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const id = (details as { readonly errorId?: unknown }).errorId;
  return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

/**
 * The reason recorded on the concluded checks and the failure comment. It
 * shows no more of the error than Eve's own failure comment did: the error
 * class, at most 160 characters of its message, and its error id.
 */
export function failedSessionReason(event: FailedSessionEvent): string {
  const name = errorName(event.details) ?? event.code;
  const message = displayLimit(event.message);
  const id = errorId(event.details);
  return [
    `The review session stopped before it could publish a verdict (${name}${message ? `: ${message}` : ""}).`,
    ...id ? [`Error id: ${id}`] : [],
    "",
    "A collaborator with write access can comment `@slop-sheriff full review` to run the review again.",
  ].join("\n");
}

/**
 * Eve emits `session.failed` without `turn.failed` when a durable step
 * exhausts its retries, so the telemetry hook that concludes checks on
 * `turn.failed` never runs. This channel handler closes the gap: every review
 * check still running on the session's head is concluded with the reason
 * before the failure comment is posted.
 */
export async function concludeFailedSession(input: {
  readonly event: FailedSessionEvent;
  readonly octokitFor: (installationId: number) => Octokit;
  readonly postComment: (body: string) => Promise<unknown>;
  readonly target: FailedSessionTarget;
}): Promise<void> {
  const reason = failedSessionReason(input.event);
  let concluded = 0;
  if (input.target.headSha === null || input.target.installationId === null) {
    console.error(JSON.stringify({
      event: "known-good-review.session_failure.checks_unresolved",
      sessionId: input.event.sessionId,
      missing: input.target.headSha === null ? "headSha" : "installationId",
    }));
  } else {
    try {
      concluded = await concludeRunningChecks({
        context: {
          headSha: input.target.headSha,
          owner: input.target.owner,
          repo: input.target.repo,
        },
        message: reason,
        octokit: input.octokitFor(input.target.installationId),
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "known-good-review.session_failure.checks_failed",
        sessionId: input.event.sessionId,
        error: error instanceof Error ? error.name : "unknown",
      }));
    }
  }
  console.info(JSON.stringify({
    event: "known-good-review.session_failure.concluded",
    sessionId: input.event.sessionId,
    code: input.event.code,
    concludedChecks: concluded,
  }));
  await input.postComment(reason);
}
