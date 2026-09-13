import { requirementObligationIdentities, requirementsForAxis } from "../../src/review/requirements";
import { readReviewEvidenceLedger } from "../../src/review/evidence-ledger";
import { currentReviewEvidenceIdentity } from "../lib/review-evidence";
import { getReviewEvidenceSandbox } from "../lib/evidence-sandbox";
import { requireReviewLane } from "../lib/review-route";
import { defineTool, toolOutput } from "eve/tools";
import type { SessionContext } from "eve/context";
import { z } from "zod";
import { trustedGitHubContext } from "../../src/github/trusted-context";
import { reviewAxisSchema } from "../../src/review/axes";
import {
  laneCheckpointDraftContentSchema,
  readLaneCheckpoint,
  validateLaneCheckpointCoverage,
  validateLaneCheckpointEvidenceProgress,
  writeLaneCheckpoint,
  type LaneCheckpoint,
} from "../../src/review/lane-checkpoint";
import {
  readReviewEvidenceManifest,
  readReviewEvidenceProgress,
  type ReviewEvidenceProgress,
} from "../../src/review/evidence-bundle";
import { githubAdapter } from "../../src/github/chat-adapter";
import { reviewConfigFromAuth } from "../../src/config/trusted-review-config";
import { publishAxisCheckpoint } from "../../src/github/publication";
import { currentLaneCheckpointIdentity } from "../lib/review-evidence";
import { attestCheckpoint } from "../../src/review/checkpoint-attestation";
import { reviewRouteState } from "../lib/review-route";

function checkpointAttestation(
  ctx: Pick<SessionContext, "session">,
  checkpoint: LaneCheckpoint | null,
  operation: "read" | "write",
  evidenceProgress?: ReviewEvidenceProgress,
): string | null {
  const parent = ctx.session.parent;
  const route = reviewRouteState.get();
  if (!checkpoint || !parent || route?.role !== "lane" || route.axis !== checkpoint.axis) return null;
  return attestCheckpoint({
    checkpoint,
    ...(evidenceProgress ? { evidenceProgress } : {}),
    rootSessionId: parent.rootSessionId,
    invocationId: parent.callId,
    attempt: route.attempt,
    operation,
    secret: process.env.KNOWN_GOOD_REVIEW_EVIDENCE_KEY,
  });
}

export const reviewLaneCheckpointInputSchema = z
  .object({
    operation: z
      .enum(["read", "write"])
      .describe("Read the current checkpoint or replace it."),
    axis: reviewAxisSchema,
    checkpoint: laneCheckpointDraftContentSchema
      .nullable()
      .describe(
        "Use null for a read operation and checkpoint content for a write operation.",
      ),
  })
  .superRefine((input, refinement) => {
    if (input.operation === "write" && input.checkpoint === null) {
      refinement.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Checkpoint writes require checkpoint content",
      });
    }
    if (input.operation === "read" && input.checkpoint !== null) {
      refinement.addIssue({
        code: "custom",
        path: ["checkpoint"],
        message: "Checkpoint reads do not accept checkpoint content",
      });
    }
  });

export default defineTool({
  description:
    "Read or replace the compact schema-v3 checkpoint for one exact review axis. The application binds each checkpoint to the immutable evidence-ledger digest. A fresh lane continuation reads this first and reconciles it with the exact manifest. Write one checkpoint before returning complete or requesting a fresh continuation. Complete checkpoints preserve a strict typed terminal report; in-progress checkpoints preserve coverage, evidence-backed observations, remaining work, and limitations without raw tool history.",
  inputSchema: reviewLaneCheckpointInputSchema,
  async execute(input, ctx) {
    if (input.operation === "write") requireReviewLane(input.axis);
    const trusted = trustedGitHubContext(ctx.session.auth.current);
    if (!trusted.patchFingerprint) {
      throw new Error(
        "Trusted review context is missing the patch fingerprint",
      );
    }
    const sandbox = await getReviewEvidenceSandbox(ctx);
    const identity = await currentLaneCheckpointIdentity(
      ctx.session.auth.current,
      sandbox,
    );
    const manifest = await readReviewEvidenceManifest(sandbox, identity);
    const ledger = await readReviewEvidenceLedger(sandbox, currentReviewEvidenceIdentity(ctx.session.auth.current));
    const requirements = requirementsForAxis(ledger.requirements ?? [], input.axis);
    const requirementIds = requirements.map((source) => source.id);
    if (input.operation === "read") {
      const checkpoint = await readLaneCheckpoint(
        sandbox,
        identity,
        input.axis,
      );
      if (checkpoint) {
        validateLaneCheckpointCoverage(checkpoint, manifest.entries.length, requirementIds, requirementObligationIdentities(requirements));
      }
      return {
        operation: "read" as const,
        checkpoint,
        attestation: checkpointAttestation(ctx, checkpoint, "read"),
      };
    }
    if (input.checkpoint === null) {
      throw new Error("Checkpoint writes require checkpoint content");
    }
    const progress = await readReviewEvidenceProgress(
      sandbox,
      manifest,
      input.axis,
    );
    validateLaneCheckpointEvidenceProgress(input.checkpoint, progress);
    const checkpoint = await writeLaneCheckpoint(
      sandbox,
      identity,
      input.axis,
      input.checkpoint,
      manifest.entries.length,
      requirementIds,
      requirementObligationIdentities(requirements),
    );
    await publishAxisCheckpoint({
      config: reviewConfigFromAuth(ctx.session.auth.current),
      axis: input.axis,
      context: trusted,
      octokit: githubAdapter(trusted.installationId).octokit,
      status: checkpoint.status,
    });
    return {
      operation: "write" as const,
      checkpoint,
      attestation: checkpointAttestation(ctx, checkpoint, "write", progress),
    };
  },
  toModelOutput(output) {
    return toolOutput.json(
      output.operation === "write"
        ? {
            operation: output.operation,
            checkpoint: {
              axis: output.checkpoint.axis,
              revision: output.checkpoint.revision,
              status: output.checkpoint.status,
            },
            attestation: output.attestation,
          }
        : output,
    );
  },
});
