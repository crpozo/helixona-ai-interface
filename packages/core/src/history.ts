import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, StoredMessage } from "./types.js";

type AnyBlock = BetaContentBlock | BetaContentBlockParam;

/**
 * Regla de reenvío de un turno de asistente que tuvo un fallback A MITAD de salida:
 * se omiten los bloques thinking / redacted_thinking / tool_use anteriores al ÚLTIMO bloque
 * `fallback`; los bloques de texto y todo lo posterior a la frontera se reenvían tal cual.
 * En cualquier otro turno el contenido se reenvía íntegro (historial append-only).
 */
export function normalizeAssistantContent(content: AnyBlock[]): AnyBlock[] {
  let lastFallback = -1;
  content.forEach((b, i) => { if (b.type === "fallback") lastFallback = i; });
  if (lastFallback < 0) return content;
  return content.filter((b, i) => {
    if (i >= lastFallback) return true;
    return !(b.type === "thinking" || b.type === "redacted_thinking" || b.type === "tool_use" || b.type === "server_tool_use");
  });
}

/** Convierte los mensajes guardados en parámetros de la API, aplicando la regla anterior. */
export function toMessageParams(messages: StoredMessage[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    const content = (m.role === "assistant" ? normalizeAssistantContent(m.content as AnyBlock[]) : m.content) as BetaContentBlockParam[];
    // Bloques de texto vacíos (p. ej. parciales descartados) no se reenvían.
    const cleaned = content.filter((b) => !(b.type === "text" && (b as { text?: string }).text === ""));
    if (cleaned.length === 0) continue;
    out.push({ role: m.role, content: cleaned });
  }
  return out;
}

/** Estimación barata de tokens para límite de contexto (≈ 3,5 caracteres por token en español). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
