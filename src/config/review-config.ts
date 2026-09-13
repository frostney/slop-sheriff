import { parse } from "yaml";
import { z } from "zod";
import {
  embeddingConfigSchema,
  type EmbeddingConfig,
} from "../memory/contracts";
import { reviewAxes, type ReviewAxis } from "../review/axes";

import { projectLanesSchema, trustedReferencePathSchema, type ProjectLane } from "../review/project-lanes";

export const defaultModels = [
  "openai/gpt-5.6-sol",
  "moonshotai/kimi-k3",
  "anthropic/claude-opus-5",
] as const;
export const defaultModel = defaultModels[0];
export const defaultSpecialistModels = ["openai/gpt-5.6-luna"] as const;
export const defaultProfile = "balanced" as const;
export const defaultEmbedding: EmbeddingConfig = {
  model: "voyage/voyage-4",
  dimension: 1024,
};

export type ModelChain = readonly [string, ...string[]];
export const reviewProfiles = ["focused", "balanced", "thorough"] as const;
export type ReviewProfile = (typeof reviewProfiles)[number];
export const specialistRoles = ["scout"] as const;
export type SpecialistRole = (typeof specialistRoles)[number];
export type ReviewAgentRole = ReviewAxis | SpecialistRole;

export interface ReviewConfig {
  readonly model: ModelChain;
  readonly embedding: EmbeddingConfig;
  readonly publicRoots: readonly string[];
  readonly profile: ReviewProfile;
  readonly blocking: boolean;
  readonly personality: boolean;
  readonly voice?: "theatrical" | "understated" | "off";
  readonly voiceGuide?: string;
  readonly voiceGuideContent?: string;
  readonly requirementPaths?: readonly string[];
  readonly lanes?: readonly ProjectLane[];
  readonly agents:
    | { readonly kind: "inherit" }
    | { readonly kind: "all"; readonly models: ModelChain }
    | {
        readonly kind: "axes";
        readonly models: Readonly<Partial<Record<ReviewAgentRole, ModelChain>>>;
      };
}

const rawConfigSchema = z
  .strictObject({
    model: z.string().optional(),
    embedding: z.string().optional(),
    embeddingDimension: z.number().int().optional(),
    publicRoots: z.array(z.string().min(1)).optional(),
    profile: z.enum(reviewProfiles).optional(),
    blocking: z.boolean().optional(),
    personality: z.boolean().optional(),
    voice: z.enum(["theatrical", "understated", "off"]).optional(),
    voiceGuide: trustedReferencePathSchema.optional(),
    requirementPaths: z.array(trustedReferencePathSchema).max(100).optional(),
    lanes: projectLanesSchema.optional(),
    agents: z
      .union([
        z.string(),
        z.record(z.string(), z.string()),
      ])
      .optional(),
  });

const gatewayModelIdPattern = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

function parseModelId(value: string, field: string): string {
  const model = value.trim();
  if (!gatewayModelIdPattern.test(model)) {
    throw new Error(`${field} must be an AI Gateway creator/model identifier`);
  }
  return model;
}

function parseModelChain(value: string, field: string): ModelChain {
  const models = value
    .split(",")
    .map((model) => parseModelId(model, field))
    .filter((model) => model.length > 0);

  if (models.length === 0) {
    throw new Error(`${field} must contain at least one model`);
  }

  const unique = [...new Set(models)];
  if (unique.length !== models.length) {
    throw new Error(`${field} must not repeat a model`);
  }

  const [first, ...rest] = unique;
  if (first === undefined) {
    throw new Error(`${field} must contain at least one model`);
  }
  return [first, ...rest];
}

function parsePublicRoots(roots: readonly string[] | undefined): string[] {
  return (roots ?? []).map((root) => {
    const normalized = root.replace(/^\.\//, "").replace(/\/$/, "");
    if (
      normalized.length === 0 ||
      normalized.startsWith("/") ||
      normalized.includes("\\") ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`publicRoots contains invalid repository path ${JSON.stringify(root)}`);
    }
    return normalized;
  });
}

export function parseReviewConfig(source: string | null | undefined): ReviewConfig {
  if (source === null || source === undefined || source.trim() === "") {
    return {
      model: [...defaultModels],
      embedding: defaultEmbedding,
      publicRoots: [],
      profile: defaultProfile,
      blocking: false,
      personality: true,
      voice: "theatrical",
      requirementPaths: [],
      lanes: [],
      agents: { kind: "inherit" },
    };
  }

  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    throw new Error(
      `Invalid review configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = rawConfigSchema.safeParse(document ?? {});
  if (!result.success) {
    throw new Error(
      `Invalid review configuration: ${z.prettifyError(result.error)}`,
    );
  }

  const model = parseModelChain(
    result.data.model ?? defaultModels.join(","),
    "model",
  );
  const embedding = embeddingConfigSchema.parse({
    model: parseModelId(
      result.data.embedding ?? defaultEmbedding.model,
      "embedding",
    ),
    dimension:
      result.data.embeddingDimension ?? defaultEmbedding.dimension,
  });
  const agents = result.data.agents;
  const publicRoots = parsePublicRoots(result.data.publicRoots);
  const profile = result.data.profile ?? defaultProfile;
  const blocking = result.data.blocking ?? false;
  const personality = result.data.personality !== false && result.data.voice !== "off";
  const extensions = {
    voice: personality ? result.data.voice ?? "theatrical" as const : "off" as const,
    ...(result.data.voiceGuide ? { voiceGuide: result.data.voiceGuide } : {}),
    requirementPaths: result.data.requirementPaths ?? [],
    lanes: result.data.lanes ?? [],
  };
  if (agents === undefined) {
    return {
      model,
      embedding,
      publicRoots,
      profile,
      blocking,
      personality,
      ...extensions,
      agents: { kind: "inherit" },
    };
  }
  if (typeof agents === "string") {
    return {
      model,
      embedding,
      publicRoots,
      profile,
      blocking,
      personality,
      ...extensions,
      agents: { kind: "all", models: parseModelChain(agents, "agents") },
    };
  }

  const models: Partial<Record<ReviewAgentRole, ModelChain>> = {};
  if (agents.commenter !== undefined) {
    parseModelChain(agents.commenter, "agents.commenter");
  }
  const acceptedRoles = [...reviewAxes, ...specialistRoles, ...extensions.lanes.map((lane) => lane.id)];
  for (const role of Object.keys(agents)) {
    if (role !== "commenter" && !acceptedRoles.some((accepted) => accepted === role)) throw new Error(`Invalid review configuration: Unknown review agent role ${role}`);
  }
  for (const role of acceptedRoles) {
    const configured = agents[role];
    if (configured !== undefined) {
      models[role] = parseModelChain(configured, `agents.${role}`);
    }
  }

  return {
    model,
    embedding,
    publicRoots,
    profile,
    blocking,
    personality,
    ...extensions,
    agents: { kind: "axes", models },
  };
}

export function modelsForSpecialist(
  config: ReviewConfig,
  role: SpecialistRole,
): ModelChain {
  if (config.agents.kind === "all") {
    return config.agents.models;
  }
  if (config.agents.kind === "axes") {
    return config.agents.models[role] ?? [...defaultSpecialistModels];
  }
  return [...defaultSpecialistModels];
}

export function modelsForAxis(
  config: ReviewConfig,
  axis: ReviewAxis,
): ModelChain {
  if (config.agents.kind === "all") {
    return config.agents.models;
  }
  if (config.agents.kind === "axes") {
    return config.agents.models[axis] ?? config.model;
  }
  return config.model;
}
