import { timingSafeEqual } from "node:crypto";
import type { GitHubWebhookVerifier } from "eve/channels/github";
import { admitReview, inspectReview } from "./client";
import { parseReviewAdmission } from "./contracts";

export function authenticatedLifecycleRequest(request: Request): boolean {
  const expected = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  const actual = request.headers.get("authorization");
  if (!expected || !actual) return false;
  const left = Buffer.from(actual), right = Buffer.from(`Bearer ${expected}`);
  return left.length === right.length && timingSafeEqual(left, right);
}
/** Replay is authorized by the persisted obligation, never by an expired Connect OIDC token. */
export async function verifiedLifecycleReplay(request: Request, body: string): Promise<boolean> {
  if (!authenticatedLifecycleRequest(request)) return false;
  const attempt = request.headers.get("x-review-attempt");
  if (!attempt) return false;
  const row = await inspectReview(attempt);
  return !!row && row.body === body && row.event === request.headers.get("x-github-event") && attempt === request.headers.get("x-github-delivery");
}
export async function admitReviewWebhook(request: Request, verifier: GitHubWebhookVerifier): Promise<Response | null> {
  let body: string;
  let payloadBody: string;
  let admission;
  try {
    body = await request.clone().text();
    payloadBody = request.headers.get("content-type")?.includes("application/x-www-form-urlencoded") ? new URLSearchParams(body).get("payload") ?? "" : body;
    const headers = new Headers(request.headers);
    if (!headers.has("x-github-delivery")) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      headers.set("x-github-delivery", `payload-${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`);
    }
    admission = parseReviewAdmission(payloadBody, headers);
  }
  catch { return null; }
  if (!admission) return null;
  try { if (!await verifier(request, body)) return new Response("unauthorized", { status: 401 }); }
  catch { return new Response("unauthorized", { status: 401 }); }
  // No fallible GitHub call or Eve dispatch precedes the durable write. Failure must reach the webhook sender.
  try { await admitReview({ ...admission, body: await compactVerifiedReviewWebhook(payloadBody) }); }
  catch { return new Response("review admission unavailable; retry delivery", { status: 503 }); }
  return Response.json({ accepted: true, status: "queued", deliveryId: admission.deliveryId }, { status: 202 });
}

/** Keep the fields consumed by the installed GitHub normalizer; fetch review content from GitHub after admission. */
export async function compactVerifiedReviewWebhook(body: string): Promise<string> {
  const raw = JSON.parse(body) as Record<string, unknown>;
  const pick = (value: unknown, keys: readonly string[]) => {
    if (typeof value !== "object" || value === null) return undefined;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(keys.filter(key => object[key] !== undefined).map(key => [key, object[key]]));
  };
  const repository = pick(raw.repository, ["id", "node_id", "full_name", "name", "private"]);
  const sender = pick(raw.sender, ["id", "login", "type", "html_url", "url"]);
  const pull = raw.pull_request as Record<string, unknown> | undefined;
  const issue = raw.issue as Record<string, unknown> | undefined;
  const comment = raw.comment as Record<string, unknown> | undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return JSON.stringify({ action: raw.action, repository, sender, installation: pick(raw.installation, ["id"]),
    ...(pull ? { pull_request: { ...pick(pull, ["number", "title", "updated_at", "draft", "state"]), head: pick(pull.head, ["sha", "ref"]), base: { ...pick(pull.base, ["sha", "ref"]), repo: pick((pull.base as Record<string, unknown> | undefined)?.repo, ["default_branch"]) } } } : {}),
    ...(issue ? { issue: { ...pick(issue, ["number"]), ...(issue.pull_request ? { pull_request: {} } : {}) } } : {}),
    ...(comment ? { comment: { ...pick(comment, ["id", "body", "html_url", "url", "created_at"]), user: pick(comment.user, ["id", "login", "type"]) } } : {}),
    verifiedPayloadSha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
  });
}
