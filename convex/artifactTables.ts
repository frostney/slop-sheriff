import { defineTable } from "convex/server";
import { v } from "convex/values";
export const vArtifactBinding = v.object({ repositoryId: v.string(), repository: v.string(), pullRequest: v.number(), baseSha: v.string(), headSha: v.string(), patchFingerprint: v.string(), reviewPolicyDigest: v.string(), attemptId: v.string() });
export const artifactTables = {
  reviewArtifactSets: defineTable({ binding: vArtifactBinding, rootScope: v.string(), signedBinding: v.string(), recoverySourceAttemptId: v.optional(v.string()) }).index("by_attemptId", ["binding.attemptId"]),
  reviewArtifacts: defineTable({ attemptId: v.string(), path: v.string(), storageId: v.id("_storage"), digest: v.string(), revision: v.optional(v.number()) }).index("by_attemptId_and_path", ["attemptId", "path"]),
};
