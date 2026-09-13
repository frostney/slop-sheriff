import { defineTable } from "convex/server";
import { v } from "convex/values";

export const reviewLifecycleTables = {
  reviewDeliveries: defineTable({
    deliveryId: v.string(), repository: v.string(), repositoryId: v.string(),
    pullRequest: v.number(), headSha: v.string(), eventTime: v.number(),
    body: v.string(), event: v.string(), signature: v.string(),
    status: v.union(v.literal("verifying"), v.literal("queued"), v.literal("dispatching"), v.literal("running"), v.literal("publishing"), v.literal("complete"), v.literal("superseded"), v.literal("interrupted")),
    attemptId: v.optional(v.string()), leaseUntil: v.number(), nextAttemptAt: v.number(),
    attempts: v.number(), sessionId: v.optional(v.string()), continuationAddress: v.optional(v.string()), previousSessionId: v.optional(v.string()), workerSessionIds: v.optional(v.array(v.string())), trustedContext: v.optional(v.string()), recoveryAuth: v.optional(v.string()), interruption: v.optional(v.string()), publicationInterruption: v.optional(v.string()), recoverySourceAttemptId: v.optional(v.string()), lastRecoveryProgressDigest: v.optional(v.string()), failureCode: v.optional(v.string()),
    publication: v.optional(v.string()), publicationKind: v.optional(v.union(v.literal("report"), v.literal("failure"))),
    publicationAttempts: v.optional(v.number()),
  }).index("by_deliveryId", ["deliveryId"])
    .index("by_attemptId", ["attemptId"])
    .index("by_repositoryId_and_status_and_nextAttemptAt", ["repositoryId", "status", "nextAttemptAt"])
    .index("by_repositoryId_and_pullRequest_and_status_and_leaseUntil", ["repositoryId", "pullRequest", "status", "leaseUntil"])
    .index("by_status_and_leaseUntil", ["status", "leaseUntil"])
    .index("by_status_and_nextAttemptAt", ["status", "nextAttemptAt"]),
  reviewQueueNotices: defineTable({ deliveryId: v.string(), repositoryId: v.string(), repository: v.string(), pullRequest: v.number(), headSha: v.string(), installationId: v.number(), status: v.union(v.literal("pending"), v.literal("retiring"), v.literal("delivered")), nextAttemptAt: v.number(), attempts: v.number() })
    .index("by_deliveryId", ["deliveryId"])
    .index("by_status_and_nextAttemptAt", ["status", "nextAttemptAt"]),
  reviewAttempts: defineTable({ attemptId: v.string(), deliveryId: v.string(), repositoryId: v.string(), pullRequest: v.number(), headSha: v.string(), startedAt: v.number(), endedAt: v.optional(v.number()), outcome: v.optional(v.string()), sessionId: v.optional(v.string()) })
    .index("by_attemptId", ["attemptId"])
    .index("by_repositoryId_and_pullRequest", ["repositoryId", "pullRequest"]),
  reviewOwners: defineTable({ repositoryId: v.string(), pullRequest: v.number(), deliveryId: v.string(), eventTime: v.number() })
    .index("by_repositoryId_and_pullRequest", ["repositoryId", "pullRequest"]),
  reviewRepositories: defineTable({ repositoryId: v.string(), lastStartedAt: v.number(), queued: v.boolean() })
    .index("by_repositoryId", ["repositoryId"])
    .index("by_queued_and_lastStartedAt", ["queued", "lastStartedAt"]),
};
