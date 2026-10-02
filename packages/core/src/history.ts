import type { AttachmentMeta, BetaContentBlock, BetaContentBlockParam, BetaMessageParam, StoredMessage } from "./types.js";

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

/**
 * Convierte los mensajes guardados en parámetros de la API, aplicando la regla anterior. Un turno
 * que usó herramientas se reenvía ronda por ronda (lo que pidió el modelo, lo que devolvieron las
 * herramientas) y al final su contenido definitivo, exactamente como ocurrió.
 */
export function toMessageParams(messages: StoredMessage[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  const push = (role: "user" | "assistant", blocks: AnyBlock[]) => {
    const content = (role === "assistant" ? normalizeAssistantContent(blocks) : blocks) as BetaContentBlockParam[];
    // Bloques de texto vacíos (p. ej. parciales descartados) no se reenvían.
    const cleaned = content.filter((b) => !(b.type === "text" && (b as { text?: string }).text === ""));
    if (cleaned.length === 0) return;
    out.push({ role, content: cleaned });
  };
  for (const m of messages) {
    for (const r of m.rounds ?? []) {
      push("assistant", r.assistant);
      push("user", r.results);
    }
    push(m.role, m.content as AnyBlock[]);
  }
  return out;
}

/**
 * An older tool turn, kept small: the rounds (what was read) are left out and the thinking blocks,
 * bound to those rounds, with them. The answer itself stays. The model reads a file again if it
 * needs it, instead of every earlier reading travelling with every message.
 */
export function withoutRounds(m: StoredMessage): StoredMessage {
  const { rounds: _rounds, ...rest } = m;
  return { ...rest, content: (m.content as AnyBlock[]).filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking") as StoredMessage["content"] };
}

/** Estimación barata de tokens para límite de contexto (≈ 3,5 caracteres por token en español). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Rough token estimate for an attachment: a PDF page costs about 2,000 tokens (text plus layout); text is ~3.5 chars/token. */
export function estimateAttachmentTokens(a: AttachmentMeta): number {
  if (a.modelChars !== undefined) return Math.ceil(a.modelChars / 3.5);
  if (a.contentType === "application/pdf") return a.pages ? a.pages * 2000 : Math.ceil(a.size / 350);
  // An Excel workbook is compressed: its text is roughly ten times the file size.
  if (a.contentType.includes("spreadsheetml")) return Math.ceil((a.size * 10) / 3.5);
  return Math.ceil(a.size / 3.5);
}
