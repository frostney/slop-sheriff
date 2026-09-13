import { expect, test } from "bun:test";
import { createGateway } from "@ai-sdk/gateway";
import { probeReviewPrerequisite, type ReviewInterruption } from "../src/lifecycle/prerequisites";
const base = { deployment: "deployment-a", credentialFingerprint: "key-a", recordedAt: 1000 };

function gateway(response: { balance?: string; creditStatus?: number; modelStatus?: number }) {
  const requests: string[] = [];
  return { requests, provider: createGateway({ apiKey: "test-key", baseURL: "https://gateway.test/v3/ai", fetch: (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (String(url).endsWith("/credits")) return Response.json(response.creditStatus ? { error: { message: "Unavailable" } } : { balance: response.balance ?? "10", total_used: "2" }, { status: response.creditStatus ?? 200 });
    return Response.json(response.modelStatus ? { error: { message: "Unavailable" } } : { models: [] }, { status: response.modelStatus ?? 200 });
  }) as typeof fetch }) };
}

test.each(["credit", "authentication", "continuation", "transient"] as const)("%s recovery probes installed Gateway read-only endpoints without generation", async kind => {
  const probe = gateway({});
  expect((await probeReviewPrerequisite({ ...base, kind }, { gateway: probe.provider })).ready).toBe(true);
  expect(probe.requests).toEqual(["GET https://gateway.test/v1/credits", "GET https://gateway.test/v3/ai/config"]);
});
test("account balance cannot bypass exhausted same-key budget, but verified rotated-key auth can recover", async () => {
  const probe = gateway({ balance: "10000" });
  const interruption: ReviewInterruption = { ...base, kind: "key-budget" };
  expect((await probeReviewPrerequisite(interruption, { gateway: probe.provider, currentCredentialFingerprint: "key-a" })).ready).toBe(false);
  expect(probe.requests).toHaveLength(0);
  expect((await probeReviewPrerequisite(interruption, { gateway: probe.provider, currentCredentialFingerprint: "key-b" })).ready).toBe(true);
  expect(probe.requests).toHaveLength(2);
});
test("deterministic failure requires a changed deployment and never uses a paid probe", async () => {
  const probe = gateway({});
  expect((await probeReviewPrerequisite({ ...base, kind: "deterministic" }, { gateway: probe.provider, currentDeployment: "deployment-a" })).ready).toBe(false);
  expect(probe.requests).toHaveLength(0);
  expect((await probeReviewPrerequisite({ ...base, kind: "configuration" }, { gateway: probe.provider, currentDeployment: "deployment-b" })).ready).toBe(true);
});
test.each([{ creditStatus: 401 }, { creditStatus: 503 }, { modelStatus: 500 }, { balance: "0" }, { balance: "NaN" }])("unavailable prerequisite never authorizes model restart: %j", async input => {
  const probe = gateway(input);
  expect((await probeReviewPrerequisite({ ...base, kind: "credit" }, { gateway: probe.provider })).ready).toBe(false);
  expect(probe.requests.every(request => request.startsWith("GET "))).toBe(true);
});
