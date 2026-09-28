import { INLINE } from "./policy.js";

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
