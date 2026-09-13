import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vEmbedding,
  vIngestionStatus,
  vMemoryCategory,
  vMemorySeverity,
  vMemoryStatus,
  vNormalizedMemory,
  vReviewKind,
  vReembedJob,
} from "./validators";

import { artifactTables } from "./artifactTables";
import { costLedgerTables } from "./costLedger";
import { reviewLifecycleTables } from "./reviewLifecycleTables";

export default defineSchema({
  ...reviewLifecycleTables,
  ...costLedgerTables,
  ...artifactTables,
  memoryAccess: defineTable({
    installationId: v.number(),
    repositoryId: v.string(),
    generation: v.number(),
  }).index("by_installation_and_repository", ["installationId", "repositoryId"])
    .index("by_installation_id", ["installationId"]),

  memoryUninstalls: defineTable({ installationId: v.number() })
    .index("by_installation_id", ["installationId"]),

  memoryDeletionDeliveries: defineTable({
    installationId: v.number(),
    repositoryId: v.string(),
    deliveryId: v.string(),
  }).index("by_installation_repository_delivery", ["installationId", "repositoryId", "deliveryId"]),

  repositoryMemory: defineTable({
    installationId: v.number(),
    repositoryId: v.string(),
    repository: v.string(),
    repositoryCreatedAt: v.number(),
    completedReviews: v.number(),
    reviewDays: v.number(),
    firstReviewAt: v.number(),
    lastReviewAt: v.number(),
    recentReviewTimes: v.array(v.number()),
    activeEmbedding: vEmbedding,
    pendingEmbedding: v.optional(vEmbedding),
    reembedGeneration: v.optional(v.number()),
    reembedJob: v.optional(vReembedJob),
    policyHash: v.string(),
    deleting: v.boolean(),
    deletionWatchdog: v.optional(v.boolean()),
  })
    .index("by_repository_id", ["repositoryId"])
    .index("by_installation_id", ["installationId"]),

  repositoryReviewDays: defineTable({
    repositoryId: v.string(),
    day: v.string(),
  }).index("by_repository_id_and_day", ["repositoryId", "day"]),

  memoryIngestions: defineTable({
    idempotencyKey: v.string(),
    memoryAdmission: v.optional(v.string()),
    installationId: v.number(),
    repositoryId: v.string(),
    repository: v.string(),
    repositoryCreatedAt: v.number(),
    pullRequest: v.number(),
    reviewKind: vReviewKind,
    base: v.string(),
    head: v.string(),
    publishedAt: v.number(),
    policyHash: v.string(),
    embedding: vEmbedding,
    memories: v.array(vNormalizedMemory),
    status: vIngestionStatus,
    attempts: v.number(),
    processingStartedAt: v.optional(v.number()),
    lastFailureCode: v.optional(v.string()),
  })
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_repository_id_and_status", ["repositoryId", "status"])
    .index("by_repository_id_and_status_and_embedding", [
      "repositoryId",
      "status",
      "embedding.model",
      "embedding.dimension",
    ])
    .index("by_repository_id_and_published_at", [
      "repositoryId",
      "publishedAt",
    ]),

  memoryEntries: defineTable({
    memoryKey: v.string(),
    clusterKey: v.string(),
    repositoryId: v.string(),
    pullRequest: v.number(),
    observedAt: v.number(),
    finding: v.string(),
    invariant: v.string(),
    cause: v.union(v.string(), v.null()),
    remedy: v.string(),
    outcome: vMemoryStatus,
    severity: vMemorySeverity,
    category: vMemoryCategory,
    provenance: vNormalizedMemory.fields.provenance,
  })
    .index("by_memory_key", ["memoryKey"])
    .index("by_repository_id_and_cluster_key_and_pull_request", [
      "repositoryId",
      "clusterKey",
      "pullRequest",
    ])
    .index("by_repository_id_and_observed_at", [
      "repositoryId",
      "observedAt",
    ]),

  memoryVectors: defineTable({
    repositoryId: v.string(),
    memoryKey: v.string(),
    embeddingModel: v.string(),
    embeddingDimension: v.number(),
    ragEntryId: v.string(),
  })
    .index("by_repository_id", ["repositoryId"])
    .index("by_repository_id_and_memory_key_and_model_and_dimension", [
      "repositoryId",
      "memoryKey",
      "embeddingModel",
      "embeddingDimension",
    ]),

  memoryClusters: defineTable({
    repositoryId: v.string(),
    clusterKey: v.string(),
    distinctPullRequests: v.number(),
    totalOccurrences: v.number(),
    lastSeenAt: v.number(),
    severity: vMemorySeverity,
    status: vMemoryStatus,
  }).index("by_repository_id_and_cluster_key", [
    "repositoryId",
    "clusterKey",
  ]),

  memoryClusterPullRequests: defineTable({
    repositoryId: v.string(),
    clusterKey: v.string(),
    pullRequest: v.number(),
  }).index("by_repository_id_and_cluster_key_and_pull_request", [
    "repositoryId",
    "clusterKey",
    "pullRequest",
  ]),
});
