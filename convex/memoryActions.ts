"use node";

import { RAG } from "@convex-dev/rag";
import { gateway } from "@ai-sdk/gateway";
import { embed } from "ai";
import { createHash } from "node:crypto";
import { v } from "convex/values";
import { z } from "zod";
import { components, internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  memorySearchRequestSchema,
  memorySearchResponseSchema,
  normalizedMemorySchema,
  embeddingConfigSchema,
  type EmbeddingConfig,
  type MemorySearchResponse,
  type NormalizedMemory,
} from "../src/memory/contracts";
import {
  durableClusterPullRequestThreshold,
  maximumEntriesPerCluster,
  memoryPolicy,
  memoryPolicyHash,
  memoryTier,
  memoryWeight,
  tieredMemoryIsActive,
} from "../src/memory/policy";
import { vEmbedding, vMemorySearchResponse } from "./validators";
import type { Doc } from "./_generated/dataModel";

type MemoryMetadata = NormalizedMemory & {
  readonly clusterKey: string;
  readonly observedAt: number;
};

const memoryMetadataSchema = normalizedMemorySchema.extend({
  clusterKey: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: z.number().int().nonnegative(),
});

function repositoryNamespace(repositoryId: string): string {
  return `github:${repositoryId}`;
}

function ragFor(embedding: EmbeddingConfig) {
  return new RAG(components.rag, {
    textEmbeddingModel: gateway.embeddingModel(embedding.model),
    embeddingDimension: embedding.dimension,
  });
}

function memoryKey(memory: NormalizedMemory): string {
  return `${memory.provenance.repositoryId}:pr:${memory.provenance.pullRequest}:finding:${memory.provenance.findingId}`;
}

function clusterKey(memory: NormalizedMemory): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        category: memory.category,
        finding: memory.finding.trim().toLowerCase(),
        remedy: memory.remedy.trim().toLowerCase(),
      }),
    )
    .digest("hex");
}

function memoryText(memory: NormalizedMemory): string {
  return [
    `Finding: ${memory.finding}`,
    `Invariant: ${memory.invariant}`,
    ...(memory.cause ? [`Cause: ${memory.cause}`] : []),
    `Remedy: ${memory.remedy}`,
    `Category: ${memory.category}`,
  ].join("\n");
}

async function embeddingForText(
  embedding: EmbeddingConfig,
  text: string,
): Promise<{ readonly vector: number[]; readonly tokens: number }> {
  const result = await embed({
    model: gateway.embeddingModel(embedding.model),
    value: text,
  });
  if (result.embedding.length !== embedding.dimension) {
    throw new Error(
      `Embedding model ${embedding.model} returned ${result.embedding.length} dimensions; configured ${embedding.dimension}`,
    );
  }
  return { vector: result.embedding, tokens: result.usage.tokens };
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function metadata(memory: NormalizedMemory, observedAt: number): MemoryMetadata {
  return { ...memory, clusterKey: clusterKey(memory), observedAt };
}

export const ingestReview = internalAction({
  args: { ingestionId: v.id("memoryIngestions") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const shouldRun = await ctx.runMutation(
      internal.memoryData.startIngestion,
      args,
    );
    if (!shouldRun) return null;
    const ingestion = await ctx.runQuery(internal.memoryData.getIngestion, args);
    if (!ingestion) return null;
    const rag = ragFor(ingestion.embedding);
    try {
      for (const memory of ingestion.memories) {
        const key = memoryKey(memory);
        const text = memoryText(memory);
        const seed = await ctx.runQuery(internal.memoryData.memoryClusterSeed, {
          repositoryId: ingestion.repositoryId,
          memoryKey: key,
        });
        if (seed.observedAt !== null && seed.observedAt > ingestion.publishedAt) continue;
        const cached = await rag.findEntryByContentHash(ctx, {
          namespace: repositoryNamespace(ingestion.repositoryId), key, contentHash: contentHash(text),
        });
        const cachedMetadata = memoryMetadataSchema.safeParse(cached?.metadata);
        if (cached?.status === "ready" && cachedMetadata.success) {
          await ctx.runMutation(internal.memoryData.recordMemory, {
            memoryKey: key,
            clusterKey: seed.existingClusterKey ?? cachedMetadata.data.clusterKey,
            ingestionId: args.ingestionId,
            ragEntryId: cached.entryId,
            embedding: ingestion.embedding,
            memory,
            observedAt: ingestion.publishedAt,
          });
          continue;
        }
        const embedded = await embeddingForText(ingestion.embedding, text);
        let assignedClusterKey =
          seed.existingClusterKey ?? clusterKey(memory);
        if (!seed.existingClusterKey && seed.hasEntries) {
          const nearest = await rag.search(ctx, {
            namespace: repositoryNamespace(ingestion.repositoryId),
            query: embedded.vector,
            limit: 1,
            vectorScoreThreshold:
              memoryPolicy.clustering.minimumVectorScore,
          });
          const candidate = nearest.entries[0]?.metadata;
          const parsedCandidate = memoryMetadataSchema.safeParse(candidate);
          if (parsedCandidate.success) {
            assignedClusterKey = parsedCandidate.data.clusterKey;
          }
        }
        const entryMetadata = {
          ...metadata(memory, ingestion.publishedAt),
          clusterKey: assignedClusterKey,
        };
        const entry = await rag.add(ctx, {
          namespace: repositoryNamespace(ingestion.repositoryId),
          key,
          title: memory.finding,
          chunks: [{ text, embedding: embedded.vector }],
          contentHash: contentHash(text),
          metadata: entryMetadata,
          importance: 1,
        });
        if (entry.replacedEntry) {
          await rag.delete(ctx, { entryId: entry.replacedEntry.entryId });
        }
        await ctx.runMutation(internal.memoryData.recordMemory, {
          memoryKey: key,
          clusterKey: assignedClusterKey,
          ingestionId: args.ingestionId,
          ragEntryId: entry.entryId,
          embedding: ingestion.embedding,
          memory,
          observedAt: ingestion.publishedAt,
        });
        console.info(
          JSON.stringify({
            event: "known-good-review.memory.embedding_completed",
            operation: "ingest",
            repositoryId: ingestion.repositoryId,
            model: ingestion.embedding.model,
            tokens: embedded.tokens,
          }),
        );
      }
      await ctx.runMutation(internal.memoryData.completeIngestion, args);
    } catch (error) {
      await ctx.runMutation(internal.memoryData.retryIngestion, {
        ingestionId: args.ingestionId,
        failureCode: error instanceof Error ? error.name : "unknown",
      });
    }
    return null;
  },
});

export const searchRepository = internalAction({
  args: {
    repositoryId: v.string(),
    // The Zod request boundary below validates built-ins and safe project lane IDs.
    axis: v.string(),
    query: v.string(),
    embedding: vEmbedding,
    limit: v.number(),
  },
  returns: vMemorySearchResponse,
  handler: async (ctx, rawArgs): Promise<MemorySearchResponse> => {
    const args = memorySearchRequestSchema.parse(rawArgs);
    const repository: Doc<"repositoryMemory"> | null = await ctx.runMutation(
      internal.memoryData.ensureEmbedding,
      { repositoryId: args.repositoryId, embedding: args.embedding },
    );
    if (!repository) {
      return memorySearchResponseSchema.parse({
        mode: "bootstrap",
        policyHash: memoryPolicyHash(),
        memories: [],
        usage: { embeddingTokens: 0 },
      });
    }
    const activeRag = ragFor(embeddingConfigSchema.parse(repository.activeEmbedding));
    const search = await activeRag.search(ctx, {
      namespace: repositoryNamespace(args.repositoryId),
      query: args.query,
      limit: Math.min(32, Math.max(args.limit * 4, args.limit)),
      vectorScoreThreshold: 0.35,
    });
    // RAG owns text/vector identity. Application records own the latest outcome
    // and provenance, which can change without re-embedding that text.
    const candidates = await ctx.runQuery(
      internal.memoryData.searchMemories,
      {
        repositoryId: args.repositoryId,
        embedding: repository.activeEmbedding,
        entries: search.entries.flatMap((entry) => entry.key
          ? [{ memoryKey: entry.key, ragEntryId: entry.entryId }] : []),
      },
    );
    const vectorScores = new Map<string, number>();
    for (const result of search.results) {
      vectorScores.set(
        result.entryId,
        Math.max(vectorScores.get(result.entryId) ?? 0, result.score),
      );
    }
    const now = Date.now();
    const stats = {
      completedReviews: repository.completedReviews,
      firstReviewAt: repository.firstReviewAt,
      lastReviewAt: repository.lastReviewAt,
      recentReviewTimes: repository.recentReviewTimes,
      repositoryCreatedAt: repository.repositoryCreatedAt,
      reviewDays: repository.reviewDays,
    };
    const threshold = durableClusterPullRequestThreshold(
      repository.completedReviews,
    );
    const ranked = candidates
      .map(({ ragEntryId, memory, cluster }) => {
        const candidate = memoryMetadataSchema.parse(memory);
        const tier = memoryTier({
          observedAt: candidate.observedAt,
          stats,
          now,
        });
        const score =
          (vectorScores.get(ragEntryId) ?? 0) *
          memoryWeight({
            distinctPullRequests: cluster.distinctPullRequests,
            severity: candidate.severity,
            status: candidate.outcome,
            tier,
          });
        return {
            ...candidate,
            tier,
            score,
            distinctPullRequests: cluster.distinctPullRequests,
            durable: cluster.distinctPullRequests >= threshold,
        };
      })
      .sort((left, right) => right.score - left.score);
    const clusterCounts = new Map<string, number>();
    const memories = ranked
      .filter((candidate) => {
        const maximum = maximumEntriesPerCluster(candidate.tier);
        if (maximum === null) return true;
        const key = `${candidate.tier}:${candidate.clusterKey}`;
        const count = clusterCounts.get(key) ?? 0;
        if (count >= maximum) return false;
        clusterCounts.set(key, count + 1);
        return true;
      })
      .slice(0, args.limit);
    console.info(
      JSON.stringify({
        event: "known-good-review.memory.search_completed",
        repositoryId: args.repositoryId,
        axis: args.axis,
        model: repository.activeEmbedding.model,
        embeddingTokens: search.usage.tokens,
        candidates: candidates.length,
        returned: memories.length,
      }),
    );
    return memorySearchResponseSchema.parse({
      mode: tieredMemoryIsActive(stats, now) ? "tiered" : "bootstrap",
      policyHash: memoryPolicyHash(),
      memories,
      usage: { embeddingTokens: search.usage.tokens },
    });
  },
});

export const reembedRepository = internalAction({
  args: {
    repositoryId: v.string(),
    token: v.optional(v.string()),
    // Accept already-scheduled calls from the previous deployment; their cursors
    // are superseded when startReembed creates a durable job.
    attempt: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const repository = await ctx.runMutation(internal.memoryData.startReembed, {
      repositoryId: args.repositoryId, ...(args.token ? { token: args.token } : {}),
    });
    const embedding = repository?.pendingEmbedding;
    const job = repository?.reembedJob;
    if (!repository || !embedding || !job) return null;
    try {
      const rag = ragFor(embedding);
      const namespace = await rag.getOrCreateNamespace(ctx, {
        namespace: repositoryNamespace(args.repositoryId),
        status: "pending",
      });
      const page = await ctx.runQuery(internal.memoryData.listMemoryEntries, {
        repositoryId: args.repositoryId,
        paginationOpts: { cursor: job.cursor, numItems: 20 },
      });
      for (const entry of page.page) {
        const memory = normalizedMemorySchema.parse({
          finding: entry.finding,
          invariant: entry.invariant,
          cause: entry.cause,
          remedy: entry.remedy,
          outcome: entry.outcome,
          severity: entry.severity,
          category: entry.category,
          provenance: entry.provenance,
        });
        const text = memoryText(memory);
        const embedded = await embeddingForText(embedding, text);
        const entryMetadata = {
          ...metadata(memory, entry.observedAt),
          clusterKey: entry.clusterKey,
        };
        const ragEntry = await rag.add(ctx, {
          namespaceId: namespace.namespaceId,
          key: entry.memoryKey,
          title: memory.finding,
          chunks: [{ text, embedding: embedded.vector }],
          contentHash: contentHash(text),
          metadata: entryMetadata,
          importance: 1,
        });
        if (ragEntry.replacedEntry) {
          await rag.delete(ctx, {
            entryId: ragEntry.replacedEntry.entryId,
          });
        }
        await ctx.runMutation(internal.memoryData.recordVectorCopy, {
          repositoryId: args.repositoryId,
          memoryKey: entry.memoryKey,
          token: job.token,
          embedding,
          ragEntryId: ragEntry.entryId,
        });
        console.info(
          JSON.stringify({
            event: "known-good-review.memory.embedding_completed",
            operation: "reembed",
            repositoryId: args.repositoryId,
            model: embedding.model,
            tokens: embedded.tokens,
          }),
        );
      }
      if (page.isDone) await ctx.runMutation(components.rag.namespaces.promoteToReady, {
        namespaceId: namespace.namespaceId,
      });
      await ctx.runMutation(internal.memoryData.completeReembed, {
        repositoryId: args.repositoryId, token: job.token,
        nextCursor: page.isDone ? null : page.continueCursor,
      });
    } catch (error) {
      await ctx.runMutation(internal.memoryData.recordReembedFailure, {
        repositoryId: args.repositoryId, token: job.token,
        failureCode: error instanceof Error ? error.name : "unknown",
      });
    }
    return null;
  },
});

export const deleteRepository = internalAction({
  args: { repositoryId: v.string(), repositoryRecordId: v.optional(v.id("repositoryMemory")) },
  returns: v.null(),
  handler: async (ctx, input) => {
    const repositoryRecordId = await ctx.runMutation(internal.memoryData.resolveDeletion, input);
    if (!repositoryRecordId) return null;
    const args = { repositoryId: input.repositoryId, repositoryRecordId };
    try {
      const processing = await ctx.runMutation(internal.memoryData.repositoryHasActiveMemoryWork, { repositoryId: args.repositoryId });
      if (processing) {
        await ctx.scheduler.runAfter(1_000, internal.memoryActions.deleteRepository, args);
        return null;
      }
      const namespaces = await ctx.runQuery(internal.memoryData.listDeletionNamespaces, args);
      if (namespaces === null) return null;
      // Delete every namespace version, including entries whose writer failed
      // between the RAG mutation and recording the application vector row.
      for (const namespaceId of namespaces) {
        await ctx.runAction(components.rag.namespaces.deleteNamespaceSync, { namespaceId });
      }
      if (namespaces.length > 0 || !await ctx.runMutation(internal.memoryData.deleteRepositoryRows, args)) {
        await ctx.scheduler.runAfter(0, internal.memoryActions.deleteRepository, args);
      }
    } catch (error) {
      console.error(JSON.stringify({
        event: "known-good-review.memory.deletion_retry", repositoryId: args.repositoryId,
        error: error instanceof Error ? error.name : "unknown",
      }));
      await ctx.scheduler.runAfter(60_000, internal.memoryActions.deleteRepository, args);
    }
    return null;
  },
});
