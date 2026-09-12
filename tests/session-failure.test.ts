import { expect, spyOn, test } from "bun:test";
import { Octokit } from "@octokit/rest";
import { githubChannel } from "eve/channels/github";
import { callAdapterEventHandler } from "../node_modules/eve/dist/src/channel/adapter.js";
import { handleReviewSessionFailure } from "../agent/lib/session-failure";
import * as publication from "../src/github/publication";
import { encodeReviewState, decodeReviewState } from "../src/github/review-state";

const context = { installationId: 1, owner: "acme", repo: "widget", repository: "acme/widget", repositoryId: "R_widget",
  repositoryCreatedAt: 0, pullRequest: 7, baseSha: "a".repeat(40), headSha: "b".repeat(40), deliveryId: "delivery-1" };

test("installed Eve channel dispatch finalizes retry exhaustion without a turn context or hook", async () => {
  const publish = spyOn(publication, "publishSessionFailure").mockResolvedValue();
  const channel = githubChannel({ events: { "session.failed": handleReviewSessionFailure } });
  // The installed channel factory's runtime adapter is deliberately inspected
  // only in this boundary fixture, not accessed by application code.
  const adapter = (channel as unknown as { adapter: Parameters<typeof callAdapterEventHandler>[0] }).adapter;
  try {
    for (const state of [{}, { slopSheriffReviewContext: context }]) {
      await callAdapterEventHandler(adapter, { type: "session.failed", data: {
        sessionId: "wrun-credit-failure", code: "FatalError",
        message: 'Step "turnStep" failed after 3 retries: A positive credit balance is required. secret-payload',
      } }, { state, session: { id: "wrun-credit-failure", auth: { current: null, initiator: null } } } as Parameters<typeof callAdapterEventHandler>[2]);
    }
    expect(publish).toHaveBeenCalledTimes(1);
    const call = publish.mock.calls[0]?.[0];
    expect(call?.message).not.toContain("secret-payload");
    expect(call?.message).toContain("insufficient credit");
    expect(call?.context).toEqual(context);
  } finally { publish.mockRestore(); }
});

test("API key rejection calls for usage investigation without prescribing a higher budget", async () => {
  const publish = spyOn(publication, "publishSessionFailure").mockResolvedValue();
  try {
    await handleReviewSessionFailure({ code: "FatalError", message: "API key budget exceeded: secret-provider-payload" }, { state: { slopSheriffReviewContext: context } });
    const message = publish.mock.calls[0]?.[0].message;
    expect(message).toContain("Investigate review usage before retrying");
    expect(message).not.toContain("secret-provider-payload");
    expect(message).not.toContain("Increase");
  } finally { publish.mockRestore(); }
});

test.each(["current", "new-head", "new-attempt", "completed", "draft", "closed"])("terminal publication protects current review ownership: %s", async (scenario) => {
  const writes: Record<string, unknown>[] = [];
  let body = encodeReviewState({ schemaVersion: 2, app: "known-good-review", pullRequest: 7,
    initialFullStatus: "running", currentHead: context.headSha, baseline: null, updatedAt: "2026-09-12T00:00:00Z" });
  const check = { id: 10, name: "slop-sheriff", status: scenario === "completed" ? "completed" : "in_progress", conclusion: scenario === "completed" ? "success" : null,
    external_id: publication.activeReviewExternalId({ ...context, deliveryId: scenario === "new-attempt" ? "delivery-2" : context.deliveryId }, { kind: "full", reason: "manual" }) };
  const axis = { id: 11, name: "slop-sheriff / engineering-quality", status: "in_progress" };
  const octokit = new Octokit({ request: { fetch: async (resource: Request | string | URL, init?: RequestInit) => {
    const url = String(resource);
    if ((init?.method ?? "GET") !== "GET") {
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push(payload);
      if (typeof payload.body === "string") body = payload.body;
      if (url.endsWith("/check-runs/10")) Object.assign(check, payload);
      if (url.endsWith("/check-runs/11")) Object.assign(axis, payload);
      return Response.json({ id: 10 });
    }
    if (url.includes("/pulls/")) return Response.json({ state: scenario === "closed" ? "closed" : "open", draft: scenario === "draft", base: { sha: context.baseSha }, head: { sha: scenario === "new-head" ? "c".repeat(40) : context.headSha } });
    if (url.includes("/comments")) return Response.json([{ id: 12, user: { id: 123, type: "Bot", login: "known-good-review[bot]" }, body }]);
    return Response.json({ check_runs: [check, axis] });
  } } });
  await publication.publishSessionFailure({ context, octokit, message: "Gateway credit exhausted" });
  if (scenario === "current") {
    expect(check).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect(axis).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect(decodeReviewState(body)).toMatchObject({ initialFullStatus: "failed", currentHead: context.headSha });
    expect(body).toContain("incomplete");
    const count = writes.length;
    await publication.publishSessionFailure({ context, octokit, message: "Gateway credit exhausted" });
    expect(writes).toHaveLength(count);
  } else expect(writes).toHaveLength(0);
});
