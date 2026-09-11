import { defaultBackend, defineSandbox } from "eve/sandbox";
import { reviewNetworkPolicy } from "../src/github/review-workspace";
import { bootstrapReviewEnvironment } from "../src/review/environment-setup";

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
  revalidationKey: () => "review-environment-v1",
  async bootstrap({ use }) {
    await bootstrapReviewEnvironment(await use());
  },
});
