import { defaultBackend, defineSandbox } from "eve/sandbox";
import type { VercelSandboxBootstrapUseOptions } from "eve/sandbox/vercel";
import { githubOnlyNetworkPolicy } from "../src/github/review-workspace";

/**
 * Template settings that keep a deployed Vercel sandbox template usable for as
 * long as a deployment references it.
 *
 * A deployed runtime opens every review sandbox from the template that
 * `eve build` prewarmed, and cannot rebuild it. Eve 0.52.5 creates that
 * template record with `persistent: false`, which Vercel reclaims after a few
 * idle days, and snapshots it without an expiration, so the snapshot takes the
 * provider default of 30 days after last use. Either loss makes every review
 * fail on start until the next deploy. Bootstrap options are applied to the
 * template sandbox only, before eve snapshots it; review sessions keep the
 * provider's default snapshot expiration.
 */
export const durableVercelTemplate = {
  persistent: true,
  snapshotExpiration: 0,
} as const satisfies VercelSandboxBootstrapUseOptions;

export default defineSandbox<VercelSandboxBootstrapUseOptions>({
  backend: defaultBackend({
    vercel: {
      networkPolicy: githubOnlyNetworkPolicy,
      resources: { vcpus: 2 },
    },
    microsandbox: {
      cpus: 2,
      memoryMiB: 4096,
      networkPolicy: githubOnlyNetworkPolicy,
    },
    // Docker cannot broker per-domain credentials. Keep its local fallback
    // offline; microsandbox is the faithful local security model.
    docker: { networkPolicy: "deny-all" },
  }),
  // Local backends ignore these Vercel-only options.
  async bootstrap({ use }) {
    await use(durableVercelTemplate);
  },
});
