import { defineTable } from "convex/server";
import { v } from "convex/values";

export const vCompletedWorkBinding = v.object({
  version: v.literal(1), repositoryId: v.string(), pullRequest: v.number(),
  sourceAttemptId: v.string(), scopeKey: v.string(), inputDigest: v.string(), contentDigest: v.string(),
});
export const reviewWorkTables = {
  completedReviewWork: defineTable({
    binding: vCompletedWorkBinding, signature: v.string(), storageId: v.id("_storage"), byteLength: v.number(),
  }).index("by_repositoryId_and_pullRequest_and_scopeKey", ["binding.repositoryId", "binding.pullRequest", "binding.scopeKey"]).index("by_repositoryId_and_pullRequest_and_scopeKey_and_inputDigest", ["binding.repositoryId", "binding.pullRequest", "binding.scopeKey", "binding.inputDigest"]).index("by_semantic_version", ["binding.repositoryId", "binding.pullRequest", "binding.scopeKey", "binding.inputDigest", "binding.contentDigest"]),
};
