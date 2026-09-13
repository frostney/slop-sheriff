import { createHash } from "node:crypto";
import { createGateway } from "@ai-sdk/gateway";
import { z } from "zod";

export const reviewInterruptionSchema = z.object({
  kind: z.enum(["github-authentication", "credit", "key-budget", "authentication", "configuration", "continuation", "transient", "deterministic"]),
  deployment: z.string(), credentialFingerprint: z.string(), recordedAt: z.number(),
});
export type ReviewInterruption = z.infer<typeof reviewInterruptionSchema>;
export function deploymentFingerprint(): string { return process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.VERCEL_DEPLOYMENT_ID ?? "local"; }
export function credentialFingerprint(): string { return createHash("sha256").update(process.env.AI_GATEWAY_API_KEY ?? "oidc").digest("hex"); }
export function classifyReviewInterruption(code: string, message: string): ReviewInterruption {
  const text = `${code} ${message}`;
  const kind = /API key budget exceeded/i.test(text) ? "key-budget"
    : /insufficient_funds|positive credit balance|insufficient credit/i.test(text) ? "credit"
    : /SESSION_TOKEN_LIMIT_REACHED/i.test(text) ? "continuation"
    : /unauthorized|authentication|invalid.api.key|\b401\b/i.test(text) ? "authentication"
    : /config|unknown.model|model.not.found/i.test(text) ? "configuration"
    : /timeout|temporar|\b429\b|\b50[0234]\b|network/i.test(text) ? "transient" : "deterministic";
  return { kind, deployment: deploymentFingerprint(), credentialFingerprint: credentialFingerprint(), recordedAt: Date.now() };
}

/** Read-only installed Gateway endpoints. Neither endpoint creates a model request. */
export async function probeReviewPrerequisite(interruption: ReviewInterruption, input: {
  readonly gateway?: Pick<ReturnType<typeof createGateway>, "getCredits" | "getAvailableModels">;
  readonly currentDeployment?: string;
  readonly currentCredentialFingerprint?: string;
} = {}): Promise<{ ready: boolean; reason: string }> {
  if (interruption.kind === "key-budget" && interruption.credentialFingerprint === (input.currentCredentialFingerprint ?? credentialFingerprint())) return { ready: false, reason: "api-key-budget-needs-verified-key-specific-repair" };
  if ((interruption.kind === "configuration" || interruption.kind === "deterministic") && interruption.deployment === (input.currentDeployment ?? deploymentFingerprint())) return { ready: false, reason: "deployment-repair-not-observed" };
  const gateway = input.gateway ?? createGateway({ fetch: Object.assign((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }), { preconnect: fetch.preconnect }) });
  try {
    const credit = await gateway.getCredits();
    const balance = Number(credit.balance);
    if (!Number.isFinite(balance) || balance <= 0) return { ready: false, reason: "gateway-credit-unavailable" };
    await gateway.getAvailableModels();
    return { ready: true, reason: "read-only-gateway-prerequisites-available" };
  } catch { return { ready: false, reason: "gateway-prerequisite-probe-unavailable" }; }
}
