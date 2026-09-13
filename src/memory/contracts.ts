import { z } from "zod";
import { reviewAxisSchema } from "../review/axes";

export const vectorDimensions = [
  128, 256, 512, 768, 1024, 1408, 1536, 2048, 3072, 4096,
] as const;

export const embeddingConfigSchema = z.object({
  model: z.string().min(3),
  dimension: z.number().int().refine(
    (dimension) => (vectorDimensions as readonly number[]).includes(dimension),
    { message: `dimension must be one of ${vectorDimensions.join(", ")}` },
  ),
});

const provenanceSchema = z.object({
  repositoryId: z.string().min(1),
  repository: z.string().min(3),
  pullRequest: z.number().int().positive(),
  base: z.string().min(1),
  head: z.string().min(1),
  path: z.string().min(1),
  symbol: z.string().nullable(),
  findingId: z.string().regex(/^CR-[1-9]\d*$/),
});

export const normalizedMemorySchema = z.object({
  finding: z.string().min(1),
  invariant: z.string().min(1),
  cause: z.string().nullable(),
  remedy: z.string().min(1),
  outcome: z.enum(["open", "deferred", "fixed"]),
  severity: z.enum(["BLOCKING", "IMPORTANT", "IMPROVEMENT", "NITPICK"]),
  category: z.enum([
    "CLAIM",
    "QUALITY",
    "ARCHITECTURE_RISK",
    "DISCOVERABILITY",
  ]),
  provenance: provenanceSchema,
});

export const memoryIngestionSchema = z.object({
  idempotencyKey: z.string().regex(/^[a-f0-9]{64}$/),
  memoryAdmission: z.string().min(1).nullable(),
  installationId: z.number().int().positive(),
  repositoryId: z.string().min(1),
  repository: z.string().min(3),
  repositoryCreatedAt: z.number().int().nonnegative(),
  pullRequest: z.number().int().positive(),
  reviewKind: z.enum(["full", "delta"]),
  base: z.string().min(1),
  head: z.string().min(1),
  publishedAt: z.number().int().nonnegative(),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  embedding: embeddingConfigSchema,
  memories: z.array(normalizedMemorySchema),
});

export const memorySearchRequestSchema = z.object({
  repositoryId: z.string().min(1),
  axis: reviewAxisSchema,
  query: z.string().min(1).max(20_000),
  embedding: embeddingConfigSchema,
  limit: z.number().int().min(1).max(20).default(8),
});

export const retrievedMemorySchema = normalizedMemorySchema.extend({
  tier: z.enum(["bootstrap", "short", "mid", "long"]),
  score: z.number(),
  distinctPullRequests: z.number().int().positive(),
  durable: z.boolean(),
  observedAt: z.number().int().nonnegative(),
});

export const memorySearchResponseSchema = z.object({
  mode: z.enum(["bootstrap", "tiered"]),
  policyHash: z.string().regex(/^[a-f0-9]{64}$/),
  memories: z.array(retrievedMemorySchema),
  usage: z.object({ embeddingTokens: z.number().int().nonnegative() }),
});

const repositoryIdsSchema = z.array(z.string().min(1));

export const memoryAdmissionRequestSchema = z.object({
  installationId: z.number().int().positive(),
  repositoryId: z.string().min(1),
});

export const memoryAdmissionResponseSchema = z.object({
  receipt: z.string().min(1).nullable(),
});

export const memoryDeletionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("repositories"),
    installationId: z.number().int().positive(),
    deliveryId: z.string().min(1).max(200),
    repositoryIds: repositoryIdsSchema.min(1),
  }),
  z.object({
    kind: z.literal("installation"),
    deliveryId: z.string().min(1).max(200),
    uninstalled: z.boolean(),
    installationId: z.number().int().positive(),
    retainedRepositoryIds: repositoryIdsSchema,
  }),
]);

export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;
export type MemoryIngestion = z.infer<typeof memoryIngestionSchema>;
export type MemoryDeletion = z.infer<typeof memoryDeletionSchema>;
export type MemorySearchRequest = z.infer<typeof memorySearchRequestSchema>;
export type MemorySearchResponse = z.infer<typeof memorySearchResponseSchema>;
export type NormalizedMemory = z.infer<typeof normalizedMemorySchema>;
