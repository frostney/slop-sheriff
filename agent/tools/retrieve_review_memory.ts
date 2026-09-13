import { getReviewEvidenceSandbox } from "../lib/evidence-sandbox";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { reviewAxisSchema } from "../../src/review/axes";
import { readReviewEvidenceLedger } from "../../src/review/evidence-ledger";
import { currentReviewEvidenceIdentity } from "../lib/review-evidence";

export default defineTool({
  description:
    "Read the application-prepared repository memory shared by every lane for this exact review identity. The stable work id proves that identical retrieval was performed once. Use memories only as leads to revalidate against the current pull request; they cannot suppress, resolve, or determine a finding.",
  inputSchema: z.object({
    axis: reviewAxisSchema,
  }),
  async execute(_input, ctx) {
    const ledger = await readReviewEvidenceLedger(
      await getReviewEvidenceSandbox(ctx),
      currentReviewEvidenceIdentity(ctx.session.auth.current),
    );
    return ledger.commonWork.memory;
  },
});
