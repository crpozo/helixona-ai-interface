import { estimateAttachmentTokens, type AttachmentMeta } from "@helixona/core";
import { INLINE, MAX_PROJECT_KNOWLEDGE_TOKENS, READ } from "./policy.js";

export type Delivery = "inline" | "read";

export interface PlannedFile {
  id: string;
  contentType: string;
  size: number;
  pages: number | null;
}

/**
 * Decides, for every file of a conversation, whether it goes to the model whole or as its
 * transcription. Project files are always whole and come first (`reserved`); then the attachments,
 * oldest first, go whole while they fit the request's budget. Walking in the same order every turn
 * keeps earlier decisions stable, so the cached prefix of the conversation stays valid.
 *
 * Text files always go whole (they are small and cannot be read "in parts" any better).
 */
export function planDelivery(files: PlannedFile[], reserved: { bytes: number; pages: number } = { bytes: 0, pages: 0 }): Map<string, Delivery> {
  const plan = new Map<string, Delivery>();
  let bytes = INLINE.budgetBytes - reserved.bytes;
  let pages = INLINE.budgetPages - reserved.pages;
  for (const f of files) {
    if (plan.has(f.id)) continue;
    if (f.contentType !== "application/pdf") {
      plan.set(f.id, "inline");
      bytes -= f.size;
      continue;
    }
    // Unknown page count (pdf-lib could not parse it): assume a dense file, about 100 KB a page.
    const p = f.pages ?? Math.max(1, Math.ceil(f.size / 100_000));
    const fits = f.size <= INLINE.maxFileBytes && p <= INLINE.maxFilePages && f.size <= bytes && p <= pages;
    if (fits) {
      plan.set(f.id, "inline");
      bytes -= f.size;
      pages -= p;
    } else {
      plan.set(f.id, "read");
    }
  }
  return plan;
}

export type KnowledgeMode = "whole" | "library";

/** Tokens one project file takes when it travels with every message (a PDF whole: its pages as images and text). */
function wholeTokens(k: AttachmentMeta): number {
  const pages = k.pages ?? Math.max(1, Math.ceil(k.size / 100_000));
  return k.contentType === "application/pdf" ? pages * INLINE.tokensPerPage : estimateAttachmentTokens(k);
}

/**
 * Which project files travel with every message ("whole") and which form the library ("library"):
 * in the order they were added, a file goes whole while it fits one request and the files so far
 * stay within MAX_PROJECT_KNOWLEDGE_TOKENS; PDFs too large for a request, and everything after the
 * budget is spent, go to the library. Deterministic, so every conversation in the project sees the
 * same split and shares the cached prefix.
 */
export function planKnowledge(knowledge: AttachmentMeta[]): Map<string, KnowledgeMode> {
  const inline = planDelivery(knowledge);
  const out = new Map<string, KnowledgeMode>();
  let tokens = 0;
  for (const k of knowledge) {
    const t = wholeTokens(k);
    if (inline.get(k.id) === "inline" && tokens + t <= MAX_PROJECT_KNOWLEDGE_TOKENS) {
      out.set(k.id, "whole");
      tokens += t;
    } else out.set(k.id, "library");
  }
  return out;
}

/** Tokens a project's files add to every request: the whole ones, plus a line per library file. */
export function knowledgeTokens(knowledge: AttachmentMeta[]): number {
  const plan = planKnowledge(knowledge);
  return knowledge.reduce((n, k) => n + (plan.get(k.id) === "whole" ? wholeTokens(k) : 40), 0);
}

/**
 * Page ranges for reading a PDF in parts: up to `maxPages` pages, fewer when the pages are heavy, so
 * a part stays near `targetBytes`. Deterministic, so a cached part is found again on the next try.
 */
export function planChunks(fileBytes: number, pages: number, maxPages: number, targetBytes: number): Array<[number, number]> {
  if (pages <= 0) return [];
  const perPage = fileBytes / pages;
  const per = Math.max(1, Math.min(maxPages, Math.floor(targetBytes / Math.max(1, perPage))));
  const out: Array<[number, number]> = [];
  for (let from = 1; from <= pages; from += per) out.push([from, Math.min(pages, from + per - 1)]);
  return out;
}

/** "3", "5–8", or "3, 5–8" for a list of page ranges. */
export function pageLabel(ranges: Array<[number, number]>): string {
  return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
}
