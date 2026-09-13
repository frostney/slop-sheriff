import { defaultBackend, defineSandbox } from "eve/sandbox";
import { reviewNetworkPolicy } from "../src/github/review-workspace";
import { acquisitionNetworkPolicy } from "../src/review/sandbox-acquisition";
import { bootstrapReviewTemplate } from "../src/review/environment-setup";

export default defineSandbox({
  backend: defaultBackend({
    vercel: {
      networkPolicy: reviewNetworkPolicy,
      resources: { vcpus: 2 },
    },
    microsandbox: {
      cpus: 2,
      memoryMiB: 4096,
      networkPolicy: reviewNetworkPolicy,
    },
    // Docker cannot broker per-domain credentials. Keep its local fallback
    // offline; microsandbox is the faithful local security model.
    docker: { networkPolicy: "deny-all" },
  }),
  revalidationKey: () => "review-environment-v2-isolated-acquisition-template-tools-v1",
  async bootstrap({ use }) {
    // Eve runs bootstrap only in a fresh, trusted template VM. It never runs
    // against a PR session or its restored filesystem/processes. Review session
    // creation and provider-loss replacement retain the deny-all factory policy.
    const template = await use();
    try {
      await template.setNetworkPolicy(acquisitionNetworkPolicy);
      await bootstrapReviewTemplate(template);
    } finally {
      await template.setNetworkPolicy("deny-all");
    }
  },
});
