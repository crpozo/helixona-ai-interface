import type { CatalogModel } from "./types";

/** Nombre legible de un modelo a partir de su id de Bedrock; si no está en el catálogo, el id. */
export function modelLabel(models: CatalogModel[] | undefined, modelId: string | null | undefined): string {
  if (!modelId) return "";
  const m = models?.find((x) => x.modelId === modelId);
  return m ? m.label : modelId;
}

export function modelLabelByAlias(models: CatalogModel[] | undefined, alias: string): string {
  const m = models?.find((x) => x.alias === alias);
  return m ? m.label : alias;
}

/** "1x", "2.5x", "5x" (formato en-US para el decimal). */
export function formatCostFactor(factor: number): string {
  const s = Number.isInteger(factor) ? String(factor) : factor.toFixed(1);
  return `${s}x`;
}
