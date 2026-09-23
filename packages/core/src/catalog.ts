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

export const DEFAULT_CATALOG: Catalog = CatalogSchema.parse({
  defaultAlias: "opus",
  effort: "medium",
  models: [
    { alias: "sonnet", modelId: "anthropic.claude-sonnet-5", label: "Sonnet 5", description: "Fast and economical: translations, letters, short summaries", costFactor: 1, priceInPerM: 2, priceOutPerM: 10, priceCacheReadPerM: 0.2, priceCacheWritePerM: 2.5, refusalFallbacks: [], availabilityFallbacks: [] },
    // Claude Opus 5.5: thinking is always on (effort is the control) and the safety classifiers are
    // broader than Opus 5's (bio joins cyber), so a medical false positive falls back to Opus 5. Opus 5
    // also covers availability until every organization has access to the new model.
    { alias: "opus", modelId: "anthropic.claude-opus-5-5", label: "Opus 5.5", description: "Recommended balance for everyday work", costFactor: 2, priceInPerM: 4, priceOutPerM: 20, priceCacheReadPerM: 0.2, priceCacheWritePerM: 5, refusalFallbacks: ["anthropic.claude-opus-5"], availabilityFallbacks: ["anthropic.claude-opus-5"] },
    { alias: "fable", modelId: "anthropic.claude-fable-5-1", label: "Fable 5.1", description: "Maximum capability for difficult tasks and long documents (slower and more expensive)", costFactor: 5, priceInPerM: 10, priceOutPerM: 50, priceCacheReadPerM: 0.25, priceCacheWritePerM: 12.5, refusalFallbacks: ["anthropic.claude-opus-5-5"], availabilityFallbacks: ["anthropic.claude-opus-5-5"] },
  ],
  fallbackModels: [
    { modelId: "anthropic.claude-opus-5", label: "Opus 5", priceInPerM: 5, priceOutPerM: 25, priceCacheReadPerM: 0.5, priceCacheWritePerM: 6.25 },
  ],
});

/**
 * Maps a model id as reported by a provider back to the catalog id. The catalog uses Bedrock-style
 * ids (`anthropic.claude-sonnet-5`); the Anthropic API reports `claude-sonnet-5` and Bedrock may
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
