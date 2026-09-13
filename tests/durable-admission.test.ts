import { expect, spyOn, test } from "bun:test";
import { githubChannel } from "eve/channels/github";
import { admitReviewWebhook, compactVerifiedReviewWebhook, verifiedLifecycleReplay } from "../src/lifecycle/webhook";

const raw = { action: "opened", installation: { id: 10 }, repository: { id: 123, node_id: "R_repo", full_name: "acme/repo", name: "repo", private: true, owner: { login: "acme" } }, sender: { id: 42, login: "maintainer", type: "User" }, pull_request: { number: 1, title: "Review title", updated_at: "2026-09-13T00:00:00Z", head: { sha: "head", ref: "branch", repo: { unused: "x".repeat(2_000_000) } }, base: { sha: "base", ref: "main", repo: { default_branch: "main" } } } };
const request = () => new Request("https://app.test/eve/v1/github", { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "delivery-1" }, body: JSON.stringify(raw) });

async function withService(run: () => Promise<void>) {
  const oldUrl = process.env.CONVEX_MEMORY_URL, oldToken = process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN;
  process.env.CONVEX_MEMORY_URL = "https://lifecycle.test"; process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = "test-only-token";
  try { await run(); } finally {
    if (oldUrl === undefined) delete process.env.CONVEX_MEMORY_URL; else process.env.CONVEX_MEMORY_URL = oldUrl;
    if (oldToken === undefined) delete process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN; else process.env.KNOWN_GOOD_REVIEW_MEMORY_TOKEN = oldToken;
  }
}

test("accepted signed admission persists bounded native transport before any fallible GitHub I/O", async () => withService(async () => {
  const order: string[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input: Parameters<typeof globalThis.fetch>[0], options?: Parameters<typeof globalThis.fetch>[1]) => {
    expect(String(input)).toBe("https://lifecycle.test/review-lifecycle/admit");
    const payload = JSON.parse(String(options?.body)) as { body: string; deliveryId: string };
    expect(payload.deliveryId).toBe("delivery-1");
    expect(payload.body.length).toBeLessThan(3000);
    expect(JSON.parse(payload.body).verifiedPayloadSha256).toMatch(/^[a-f0-9]{64}$/);
    order.push("persist"); return Response.json({ duplicate: false });
  }) as typeof globalThis.fetch);
  try {
    const response = await admitReviewWebhook(request(), async () => { order.push("verify"); return true; });
    expect(response?.status).toBe(202);
    expect(order).toEqual(["verify", "persist"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { fetch.mockRestore(); }
}));

test("admission outage reaches webhook sender as503 instead of Eve swallowing accepted work", async () => withService(async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network unavailable"));
  try { expect((await admitReviewWebhook(request(), async () => true))?.status).toBe(503); }
  finally { fetch.mockRestore(); }
}));

test("unverified requests never enter durable storage", async () => {
  const fetch = spyOn(globalThis, "fetch");
  try { expect((await admitReviewWebhook(request(), async () => false))?.status).toBe(401); expect(fetch).not.toHaveBeenCalled(); }
  finally { fetch.mockRestore(); }
});

test("projected verified transport still crosses the installed native GitHub parser and authored handler", async () => {
  let observed: unknown;
  const channel = githubChannel({ botName: "slop-sheriff", credentials: { webhookVerifier: () => true }, onPullRequest(ctx, event) { observed = { repository: ctx.repository.fullName, number: event.pullRequestNumber, action: event.action }; return null; } });
  const route = channel.routes.find(route => route.method === "POST" && route.path === "/eve/v1/github");
  if (!route || route.method !== "POST") throw new Error("Native GitHub route missing");
  const body = await compactVerifiedReviewWebhook(JSON.stringify(raw));
  const response = await route.handler(new Request("https://app.test/eve/v1/github", { method: "POST", headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-github-delivery": "attempt-id" }, body }), {
    from: () => { throw new Error("An ignored event must not start a model"); }, resolveSession: async () => undefined,
    attachSession: () => { throw new Error("No session needed"); }, to: () => { throw new Error("No model needed"); }, params: {}, waitUntil: task => { void task; }, requestIp: null,
  });
  expect(response.status).toBeLessThan(300);
  expect(observed).toEqual({ repository: "acme/repo", number: 1, action: "opened" });
});

test("internal replay requires service authentication plus the exact persisted body,event,and attempt", async () => withService(async () => {
  const body = await compactVerifiedReviewWebhook(JSON.stringify(raw));
  const job = { deliveryId: "delivery-1", repository: "acme/repo", repositoryId: "R_repo", pullRequest: 1, headSha: "head", eventTime: 1000, body, event: "pull_request", signature: "", attemptId: "attempt-id" };
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(job));
  try {
    const make = (token: string, attempt = "attempt-id") => new Request("https://app.test/eve/v1/review-lifecycle", { headers: { authorization: `Bearer ${token}`, "x-review-attempt": attempt, "x-github-delivery": attempt, "x-github-event": "pull_request" } });
    expect(await verifiedLifecycleReplay(make("wrong"), body)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(await verifiedLifecycleReplay(make("test-only-token"), body)).toBe(true);
    fetch.mockResolvedValue(Response.json(job));
    expect(await verifiedLifecycleReplay(make("test-only-token"), `${body} `)).toBe(false);
  } finally { fetch.mockRestore(); }
}));

test("reset/send failure cannot attach an old session found at the shared PR address", async () => withService(async () => {
  const { reconcileDurableReview } = await import("../agent/lib/reconcile-review-worker");
  const calls: unknown[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (url: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json(null); }) as typeof globalThis.fetch);
  const old = { id: "previous-review-session" } as import("eve/channels").Session;
  try {
    await reconcileDurableReview({ deliveryId: "webhook", attemptId: "new-attempt", repository: "acme/repo", repositoryId: "R_repo", pullRequest: 1, headSha: "new-head", eventTime: 1000, body: "{}", event: "pull_request", signature: "", continuationAddress: "same-address", previousSessionId: old.id }, {
      resolveSession: async () => old,
      attachSession: () => { throw new Error("Must not attach a predecessor as this attempt"); },
    });
    expect(calls).toEqual([{ url: "https://lifecycle.test/review-lifecycle/finish", body: { attemptId: "new-attempt", outcome: "retry", failureCode: "session_admission_missing" } }]);
  } finally { fetch.mockRestore(); }
}));
