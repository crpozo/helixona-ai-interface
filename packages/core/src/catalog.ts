import { z } from "zod";

/**
 * Catálogo de modelos: configuración bajo control de cambios, nunca IDs en código.
 * "Siempre la última versión" se resuelve cambiando este JSON (SSM/env) tras el checklist
 * descrito en docs/DISENO-ARQUITECTURA.md §7b.
 */
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

const PricesSchema = z.object({
  priceInPerM: z.number().nonnegative(),
  priceOutPerM: z.number().nonnegative(),
  priceCacheReadPerM: z.number().nonnegative(),
  priceCacheWritePerM: z.number().nonnegative(),
});

export const CatalogModelSchema = PricesSchema.extend({
  alias: z.string().regex(/^[a-z0-9-]{2,32}$/),
  modelId: z.string().min(3),
  label: z.string().min(1).max(40),
  description: z.string().max(200).default(""),
  costFactor: z.number().positive().default(1),
  /** Modelos (por ID) a los que cae por rechazo del clasificador, en orden. */
  refusalFallbacks: z.array(z.string()).default([]),
  /** Modelos (por ID) a los que cae por indisponibilidad, en orden. */
  availabilityFallbacks: z.array(z.string()).default([]),
  /** Roles que pueden elegir este modelo. */
  roles: z.array(z.enum(["staff", "admin"])).default(["staff", "admin"]),
});
export type CatalogModel = z.infer<typeof CatalogModelSchema>;

/** Modelos no seleccionables pero que pueden servir como respaldo (precio y etiqueta). */
export const FallbackModelSchema = PricesSchema.extend({
  modelId: z.string().min(3),
  label: z.string().min(1).max(40),
});
export type FallbackModel = z.infer<typeof FallbackModelSchema>;

export const CatalogSchema = z.object({
  defaultAlias: z.string(),
  effort: EffortSchema.default("medium"),
  models: z.array(CatalogModelSchema).min(1),
  fallbackModels: z.array(FallbackModelSchema).default([]),
}).superRefine((c, ctx) => {
  const aliases = new Set<string>();
  const ids = new Set<string>(c.models.map((m) => m.modelId));
  for (const f of c.fallbackModels) ids.add(f.modelId);
  for (const m of c.models) {
    if (aliases.has(m.alias)) ctx.addIssue({ code: "custom", message: `duplicate alias: ${m.alias}` });
    aliases.add(m.alias);
    for (const fb of [...m.refusalFallbacks, ...m.availabilityFallbacks]) {
      if (fb === m.modelId) ctx.addIssue({ code: "custom", message: `${m.alias}: a model cannot be its own fallback` });
      if (!ids.has(fb)) ctx.addIssue({ code: "custom", message: `${m.alias}: fallback ${fb} is not in models or fallbackModels (missing price/label)` });
    }
  }
  if (!aliases.has(c.defaultAlias)) ctx.addIssue({ code: "custom", message: `defaultAlias ${c.defaultAlias} does not exist` });
});
export type Catalog = z.infer<typeof CatalogSchema>;

/**
 * Model policy: each alias always points to the newest model of its line (Haiku, Sonnet, Opus, Fable), and a
 * conversation follows its alias (see currentModelId), so a new release is one line here. The previous
 * generation stays only as a fallback, for a classifier false positive or while a new model is not
 * yet enabled for the organization.
 */
export const DEFAULT_CATALOG: Catalog = CatalogSchema.parse({
  defaultAlias: "opus",
  effort: "medium",
  models: [
    // Claude Haiku 5.5: the cheapest and fastest ($0.10 / $0.50 per million up to 100K-token prompts; the
    // estimate here uses those rates). Its safety classifiers have no server-side fallback, so a refusal
    // and an outage both go to Sonnet 5.5.
    { alias: "haiku", modelId: "anthropic.claude-haiku-5-5", label: "Haiku 5.5", description: "Fastest and cheapest: quick questions, short drafts, simple edits", costFactor: 0.05, priceInPerM: 0.1, priceOutPerM: 0.5, priceCacheReadPerM: 0.01, priceCacheWritePerM: 0.125, refusalFallbacks: ["anthropic.claude-sonnet-5-5"], availabilityFallbacks: ["anthropic.claude-sonnet-5-5"] },
    // Claude Sonnet 5.5: same price as Sonnet 5; its classifiers decline in more categories (bio and
    // general_harms among them), so a medical false positive falls back to Sonnet 5, which also covers
    // availability until the organization has access to the new model.
    { alias: "sonnet", modelId: "anthropic.claude-sonnet-5-5", label: "Sonnet 5.5", description: "Fast and economical: translations, letters, short summaries", costFactor: 1, priceInPerM: 2, priceOutPerM: 10, priceCacheReadPerM: 0.2, priceCacheWritePerM: 2.5, refusalFallbacks: ["anthropic.claude-sonnet-5"], availabilityFallbacks: ["anthropic.claude-sonnet-5"] },
    // Claude Opus 5.5: thinking is always on (effort is the control) and the safety classifiers are
    // broader than Opus 5's (bio joins cyber), so a medical false positive falls back to Opus 5. Opus 5
    // also covers availability until every organization has access to the new model.
    { alias: "opus", modelId: "anthropic.claude-opus-5-5", label: "Opus 5.5", description: "Recommended balance for everyday work", costFactor: 2, priceInPerM: 4, priceOutPerM: 20, priceCacheReadPerM: 0.2, priceCacheWritePerM: 5, refusalFallbacks: ["anthropic.claude-opus-5"], availabilityFallbacks: ["anthropic.claude-opus-5"] },
    // Claude Fable 5.2: the current Fable, cheaper than 5.1 ($8 / $40). Its history-editing check applies to
    // every account; the provider already asks for mismatched thinking blocks to be dropped, not refused.
    { alias: "fable", modelId: "anthropic.claude-fable-5-2", label: "Fable 5.2", description: "Maximum capability for difficult tasks and long documents (slower and more expensive)", costFactor: 4, priceInPerM: 8, priceOutPerM: 40, priceCacheReadPerM: 0.2, priceCacheWritePerM: 10, refusalFallbacks: ["anthropic.claude-opus-5-5"], availabilityFallbacks: ["anthropic.claude-fable-5-1", "anthropic.claude-opus-5-5"] },
  ],
  fallbackModels: [
    { modelId: "anthropic.claude-sonnet-5", label: "Sonnet 5", priceInPerM: 2, priceOutPerM: 10, priceCacheReadPerM: 0.2, priceCacheWritePerM: 2.5 },
    { modelId: "anthropic.claude-opus-5", label: "Opus 5", priceInPerM: 5, priceOutPerM: 25, priceCacheReadPerM: 0.5, priceCacheWritePerM: 6.25 },
    { modelId: "anthropic.claude-fable-5-1", label: "Fable 5.1", priceInPerM: 10, priceOutPerM: 50, priceCacheReadPerM: 0.25, priceCacheWritePerM: 12.5 },
  ],
});

/**
 * OpenAI's current models, offered next to the Claude ones only when the server has an OpenAI API key
 * (see `withOpenAi`). Ids carry the `openai.` prefix; prices are OpenAI's standard rates per million
 * tokens for prompts up to 272K tokens (longer prompts cost more; the estimate here uses these rates).
 * OpenAI does not charge extra to write the prompt cache. A busy model falls back to the next one
 * down within OpenAI, never to another vendor.
 */
export const OPENAI_MODELS: CatalogModel[] = [
  { alias: "gpt-luna", modelId: "openai.gpt-6-luna", label: "GPT-6 Luna", description: "OpenAI's fastest and cheapest: quick questions and simple edits", costFactor: 0.05, priceInPerM: 0.1, priceOutPerM: 0.5, priceCacheReadPerM: 0.01, priceCacheWritePerM: 0.1, refusalFallbacks: [], availabilityFallbacks: [], roles: ["staff", "admin"] },
  { alias: "gpt-terra", modelId: "openai.gpt-6.1-terra", label: "GPT-6.1 Terra", description: "OpenAI's efficient model: images, screenshots and everyday drafts", costFactor: 0.5, priceInPerM: 1, priceOutPerM: 5, priceCacheReadPerM: 0.05, priceCacheWritePerM: 1, refusalFallbacks: [], availabilityFallbacks: ["openai.gpt-6-luna"], roles: ["staff", "admin"] },
  { alias: "gpt-sol", modelId: "openai.gpt-6.1-sol", label: "GPT-6.1 Sol", description: "OpenAI's balanced model for everyday work", costFactor: 1, priceInPerM: 2, priceOutPerM: 10, priceCacheReadPerM: 0.1, priceCacheWritePerM: 2, refusalFallbacks: [], availabilityFallbacks: ["openai.gpt-6.1-terra"], roles: ["staff", "admin"] },
  { alias: "gpt-astra", modelId: "openai.gpt-6-astra", label: "GPT-6 Astra", description: "OpenAI's most capable model for difficult tasks (slower and more expensive)", costFactor: 5, priceInPerM: 10, priceOutPerM: 50, priceCacheReadPerM: 1, priceCacheWritePerM: 10, refusalFallbacks: [], availabilityFallbacks: ["openai.gpt-6.1-sol"], roles: ["staff", "admin"] },
];

/**
 * The catalog with OpenAI's models after the Claude ones (the default model does not change).
 * `via: "bedrock"`: the models are served by Amazon Bedrock through its US cross-Region profiles,
 * which cost 10% more than OpenAI's list prices.
 */
export function withOpenAi(catalog: Catalog, via: "openai" | "bedrock" = "openai"): Catalog {
  const have = new Set(catalog.models.map((m) => m.alias));
  const k = via === "bedrock" ? 1.1 : 1;
  const price = (n: number) => Math.round(n * k * 1e6) / 1e6;
  const models = OPENAI_MODELS.filter((m) => !have.has(m.alias)).map((m) => ({ ...m, priceInPerM: price(m.priceInPerM), priceOutPerM: price(m.priceOutPerM), priceCacheReadPerM: price(m.priceCacheReadPerM), priceCacheWritePerM: price(m.priceCacheWritePerM) }));
  return CatalogSchema.parse({ ...catalog, models: [...catalog.models, ...models] });
}

/** The id Amazon Bedrock takes for an OpenAI model: its US cross-Region inference profile. */
export function bedrockOpenAiModelId(catalogModelId: string): string {
  return `us.${catalogModelId}`;
}

/** A model served by OpenAI (its id carries the `openai.` prefix). */
export function isOpenAiModelId(modelId: string): boolean {
  return modelId.startsWith("openai.");
}

/**
 * Maps a model id as reported by a provider back to the catalog id. The catalog uses Bedrock-style
 * ids (`anthropic.claude-sonnet-5-5`); the Anthropic API reports `claude-sonnet-5-5` and Bedrock may
 * report a region-prefixed inference profile (`us.anthropic.…`). Unknown ids are returned as-is.
 */
export function canonicalModelId(catalog: Catalog, id: string): string {
  const known = [...catalog.models, ...catalog.fallbackModels].map((m) => m.modelId);
  if (known.includes(id)) return id;
  const bare = stripProviderPrefix(id);
  return known.find((k) => stripProviderPrefix(k) === bare) ?? id;
}

function stripProviderPrefix(id: string): string {
  return id.replace(/^(?:[a-z]{2}\.)?anthropic\./, "");
}

export function parseCatalog(json: string | undefined | null): Catalog {
  if (!json || json.trim() === "") return DEFAULT_CATALOG;
  return CatalogSchema.parse(JSON.parse(json));
}

export function modelByAlias(catalog: Catalog, alias: string): CatalogModel | undefined {
  return catalog.models.find((m) => m.alias === alias);
}

/**
 * The model a conversation uses now: the one its alias points to today, so a conversation started on
 * an earlier model moves to the newest one. The stored id is kept only if the alias left the catalog.
 */
export function currentModelId(catalog: Catalog, alias: string, stored: string): string {
  return modelByAlias(catalog, alias)?.modelId ?? stored;
}

export function pricesFor(catalog: Catalog, modelId: string): (FallbackModel & { alias?: string }) | undefined {
  const m = catalog.models.find((x) => x.modelId === modelId);
  if (m) return m;
  return catalog.fallbackModels.find((x) => x.modelId === modelId);
}

export function labelFor(catalog: Catalog, modelId: string): string {
  return pricesFor(catalog, modelId)?.label ?? modelId;
}

export function modelsForRole(catalog: Catalog, roles: string[]): CatalogModel[] {
  return catalog.models.filter((m) => m.roles.some((r) => roles.includes(r)));
}

export interface UsageTokens { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

export function estimateUsd(catalog: Catalog, modelId: string, u: UsageTokens): number {
  const p = pricesFor(catalog, modelId);
  if (!p) return 0;
  const usd = (u.inputTokens * p.priceInPerM + u.outputTokens * p.priceOutPerM + u.cacheReadTokens * p.priceCacheReadPerM + u.cacheWriteTokens * p.priceCacheWritePerM) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
