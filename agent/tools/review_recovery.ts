import { outsideReviewWork } from "../lib/review-capabilities";
import { getReviewEvidenceSandbox } from "../lib/evidence-sandbox";
import { defineTool, toolOutput } from "eve/tools";
import { z } from "zod";
import {
  currentRecoveryState,
  reviewRecoveryState,
} from "../lib/review-recovery";
import {
  advanceReviewRecovery,
  recoveryWork,
} from "../../src/review/recovery";
import { readLaneCheckpoint } from "../../src/review/lane-checkpoint";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { currentLaneCheckpointIdentity } from "../lib/review-evidence";

export const reviewRecoveryInputSchema = z
  .object({
    operation: z.enum(["read", "advance"]),
    stage: z.literal("axes-complete").nullable(),
  })
  .superRefine((input, context) => {
    if (input.operation === "read" && input.stage !== null) {
      context.addIssue({
        code: "custom",
        path: ["stage"],
        message: "Recovery reads do not accept a stage",
      });
    }
    if (input.operation === "advance" && input.stage === null) {
      context.addIssue({
        code: "custom",
        path: ["stage"],
        message: "Recovery advancement requires a stage",
      });
    }
  });

export const reviewTool = defineTool({
  description:
    "Read the trusted review recovery packet or verify axes-complete against every exact lane checkpoint. Use null stage for reads. Revalidation and report tools own later stage transitions.",
  inputSchema: reviewRecoveryInputSchema,
  async execute(input, ctx) {
    if (ctx.session.parent) {
      throw new Error("Only the review coordinator can manage recovery state");
    }
    let recovery = currentRecoveryState(ctx.session.auth.current);
    if (input.operation === "advance") {
      if (input.stage !== "axes-complete") {
        throw new Error("Recovery advancement requires axes-complete");
      }
      const trusted = trustedGitHubContext(ctx.session.auth.current);
      if (!trusted.patchFingerprint) {
        throw new Error("Trusted review recovery is missing patch identity");
      }
      const sandbox = await getReviewEvidenceSandbox(ctx);
      const checkpointIdentity = await currentLaneCheckpointIdentity(
        ctx.session.auth.current,
        sandbox,
      );
      const completedAxes: typeof recovery.completedAxes = [];
      for (const axis of recovery.activeAxes) {
        const checkpoint = await readLaneCheckpoint(
          sandbox,
          checkpointIdentity,
          axis,
        );
        if (checkpoint?.status === "complete") completedAxes.push(axis);
      }
      recovery = advanceReviewRecovery(recovery, {
        completedAxes,
        stage: input.stage,
      });
      reviewRecoveryState.update(() => recovery);
    }
    return {
      operation: input.operation,
      recovery,
      remainingWork: recoveryWork(recovery),
    };
  },
  toModelOutput(output) {
    return toolOutput.json(output);
  },
});

export default outsideReviewWork(reviewTool);
