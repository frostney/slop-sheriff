import { z } from "zod";
import { chainForRoute } from "./routing";
import {
  modelsForSpecialist,
  specialistRoles,
  type ReviewConfig,
  reviewTasks,
} from "../config/review-config";

const catalogModelSchema = z.object({
  id: z.string(),
  type: z.string(),
  tags: z.array(z.string()).nullable().optional(),
});

const catalogSchema = z.object({ data: z.array(catalogModelSchema) });
type CatalogModel = z.infer<typeof catalogModelSchema>;

const catalogUrl = "https://ai-gateway.vercel.sh/v1/models";
const catalogTtlMs = 5 * 60 * 1_000;
let cachedCatalog:
  | { readonly expiresAt: number; readonly models: ReadonlyMap<string, CatalogModel> }
  | undefined;
let loadingCatalog: Promise<ReadonlyMap<string, CatalogModel>> | undefined;

async function gatewayModels(): Promise<ReadonlyMap<string, CatalogModel>> {
  if (cachedCatalog && cachedCatalog.expiresAt > Date.now()) {
    return cachedCatalog.models;
  }
  loadingCatalog ??= fetchGatewayModels().finally(() => { loadingCatalog = undefined; });
  return loadingCatalog;
}

async function fetchGatewayModels(): Promise<ReadonlyMap<string, CatalogModel>> {
  const response = await fetch(catalogUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`AI Gateway model discovery failed with HTTP ${response.status}`);
  }
  const catalog = catalogSchema.parse(await response.json());
  const models = new Map(catalog.data.map((model) => [model.id, model]));
  cachedCatalog = { expiresAt: Date.now() + catalogTtlMs, models };
  return models;
}

export async function validateConfiguredModels(
  config: ReviewConfig,
): Promise<void> {
  const catalog = await gatewayModels();
  const languageModels = new Set(config.model);
  for (const task of reviewTasks) {
    for (const difficulty of ["routine", "ambiguous", "conflicting"] as const) {
      chainForRoute(config, { role: "coordinator", task, attempt: 0, difficulty }).forEach(model => languageModels.add(model));
    }
  }
  for (const settings of Object.values(config.tasks ?? {})) {
    settings?.model?.forEach(model => languageModels.add(model));
    settings?.escalationModel?.forEach(model => languageModels.add(model));
  }
  specialistRoles.forEach((role) =>
    modelsForSpecialist(config, role).forEach((model) => languageModels.add(model)),
  );
  if (config.agents.kind === "all") {
    config.agents.models.forEach((model) => languageModels.add(model));
  } else if (config.agents.kind === "axes") {
    Object.values(config.agents.models).forEach((chain) =>
      chain?.forEach((model) => languageModels.add(model)),
    );
  }

  for (const modelId of languageModels) {
    const model = catalog.get(modelId);
    if (!model) throw new Error(`AI Gateway does not list language model ${modelId}`);
    if (model.type !== "language" || !model.tags?.includes("tool-use")) {
      throw new Error(`AI Gateway model ${modelId} does not support required tool use`);
    }
  }

  const embedding = catalog.get(config.embedding.model);
  if (!embedding) {
    throw new Error(`AI Gateway does not list embedding model ${config.embedding.model}`);
  }
  if (embedding.type !== "embedding") {
    throw new Error(`AI Gateway model ${config.embedding.model} is not an embedding model`);
  }
}
