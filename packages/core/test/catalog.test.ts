import { describe, expect, it } from "vitest";
import { CatalogSchema, DEFAULT_CATALOG, estimateUsd, labelFor, modelsForRole, parseCatalog } from "../src/catalog.js";

describe("catálogo", () => {
  it("el catálogo por defecto es válido y tiene los tres alias", () => {
    expect(DEFAULT_CATALOG.models.map((m) => m.alias)).toEqual(["sonnet", "opus", "fable"]);
    expect(DEFAULT_CATALOG.defaultAlias).toBe("opus");
  });
  it("rechaza un modelo que sea su propio respaldo o un respaldo sin precio", () => {
    const bad = { ...DEFAULT_CATALOG, models: DEFAULT_CATALOG.models.map((m) => (m.alias === "opus" ? { ...m, refusalFallbacks: ["anthropic.claude-opus-5-5"] } : m)) };
    expect(() => CatalogSchema.parse(bad)).toThrow();
    const bad2 = { ...DEFAULT_CATALOG, models: DEFAULT_CATALOG.models.map((m) => (m.alias === "opus" ? { ...m, refusalFallbacks: ["anthropic.desconocido"] } : m)) };
    expect(() => CatalogSchema.parse(bad2)).toThrow();
  });
  it("estima costo con precios del modelo servido, incluido un modelo solo de respaldo", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(estimateUsd(DEFAULT_CATALOG, "anthropic.claude-fable-5-1", u)).toBe(10);
    expect(estimateUsd(DEFAULT_CATALOG, "anthropic.claude-opus-5-5", u)).toBe(4);
    expect(estimateUsd(DEFAULT_CATALOG, "anthropic.claude-opus-5", u)).toBe(5);
    expect(labelFor(DEFAULT_CATALOG, "anthropic.claude-opus-5")).toBe("Opus 5");
  });
  it("filtra modelos por rol y parsea JSON", () => {
    const json = JSON.stringify({ ...DEFAULT_CATALOG, models: DEFAULT_CATALOG.models.map((m) => (m.alias === "fable" ? { ...m, roles: ["admin"] } : m)) });
    const c = parseCatalog(json);
    expect(modelsForRole(c, ["staff"]).map((m) => m.alias)).toEqual(["sonnet", "opus"]);
    expect(parseCatalog(undefined)).toBe(DEFAULT_CATALOG);
  });
});
