import { parseReviewConfig } from "../../../../../src/config/review-config";
import { projectLaneRegistryDigest } from "../../../../../src/review/project-lane-identity";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { readLaneCheckpoint, writeLaneCheckpoint } from "../../../../../src/review/lane-checkpoint";
import { reviewRouteState } from "../../../../../agent/lib/review-route";
import { evidenceSandbox, identity, checkpointContent, runtimeProjectConfig } from "../lib/orchestration";
import { attestCheckpoint } from "../../../../../src/review/checkpoint-attestation";

export default defineTool({
  description: "Write one signed synthetic checkpoint for the assigned runtime lane.", inputSchema: z.strictObject({}),
  async execute(_input, ctx) {
    const route = reviewRouteState.get();
    if (route?.role !== "lane") throw new Error("Expected a bound review lane");
    const checkpointIdentity = { ...identity, laneRegistryDigest: route.axis.startsWith("project-") ? projectLaneRegistryDigest(parseReviewConfig(runtimeProjectConfig)) : undefined };
    const sandbox = await evidenceSandbox(ctx);
    const prior = await readLaneCheckpoint(sandbox, checkpointIdentity, route.axis);
    if (route.attempt === 1 && prior?.revision !== 1) throw new Error("Fresh continuation lost its signed checkpoint");
    const checkpoint = prior?.status === "complete" ? prior : await writeLaneCheckpoint(sandbox, checkpointIdentity, route.axis, checkpointContent(route.axis, route.axis === "engineering-quality" && route.attempt === 0), 0);
    if (!ctx.session.parent) throw new Error("Expected a child invocation identity");
    return { revision: checkpoint.revision, status: checkpoint.status,
      attestation: attestCheckpoint({ checkpoint, rootSessionId: ctx.session.parent.rootSessionId, invocationId: ctx.session.parent.callId, attempt: route.attempt, operation: prior?.status === "complete" ? "read" : "write", secret: "1".repeat(64) }),
    };
  },
});
