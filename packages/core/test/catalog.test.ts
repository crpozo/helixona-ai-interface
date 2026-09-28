import { describe, expect, it } from "vitest";
import { CatalogSchema, currentModelId, DEFAULT_CATALOG, estimateUsd, labelFor, modelsForRole, parseCatalog } from "../src/catalog.js";

describe("catálogo", () => {
  it("el catálogo por defecto es válido y tiene los tres alias", () => {
    expect(DEFAULT_CATALOG.models.map((m) => m.alias)).toEqual(["sonnet", "opus", "fable"]);
    expect(DEFAULT_CATALOG.defaultAlias).toBe("opus");
  });
  it("each alias points to the newest model of its line; the previous generation is only a fallback", () => {
    expect(Object.fromEntries(DEFAULT_CATALOG.models.map((m) => [m.alias, m.modelId]))).toEqual({
      sonnet: "anthropic.claude-sonnet-5-5",
      opus: "anthropic.claude-opus-5-5",
      fable: "anthropic.claude-fable-5-1",
    });
    expect(DEFAULT_CATALOG.fallbackModels.map((m) => m.modelId)).toEqual(["anthropic.claude-sonnet-5", "anthropic.claude-opus-5"]);
    const sonnet = DEFAULT_CATALOG.models[0]!;
    expect(sonnet.refusalFallbacks).toEqual(["anthropic.claude-sonnet-5"]);
    expect(estimateUsd(DEFAULT_CATALOG, sonnet.modelId, { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(12);
    // A conversation started on an earlier model follows its alias to the newest one.
    expect(currentModelId(DEFAULT_CATALOG, "sonnet", "anthropic.claude-sonnet-5")).toBe("anthropic.claude-sonnet-5-5");
    expect(currentModelId(DEFAULT_CATALOG, "opus", "anthropic.claude-opus-5")).toBe("anthropic.claude-opus-5-5");
    expect(currentModelId(DEFAULT_CATALOG, "retired", "anthropic.claude-old")).toBe("anthropic.claude-old");
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
