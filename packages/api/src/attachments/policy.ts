/**
 * Attachment policy shared by the upload and chat routes: accepted types, size caps and object keys.
 * No imports on purpose (also used by /api/me), so it never creates import cycles.
 */

export type AttachmentKind = "pdf" | "text";

/** Accepted MIME types. `maxMb: null` means the configurable MAX_ATTACHMENT_MB applies. */
export const ALLOWED_TYPES: Record<string, { kind: AttachmentKind; maxMb: number | null }> = {
  "application/pdf": { kind: "pdf", maxMb: null },
  "text/plain": { kind: "text", maxMb: 5 },
  "text/markdown": { kind: "text", maxMb: 5 },
  "text/csv": { kind: "text", maxMb: 5 },
};

/** Claude reads PDFs natively up to this many pages per file (1M-context models). */
export const MAX_PDF_PAGES = 600;

/** Keeps a display name that is safe as an object key and in logs: no paths, no control characters. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^A-Za-z0-9._ ()-]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned || "file";
}

/** Object key: scoped to the conversation, so ownership is enforced by the conversation lookup. */
export function attachmentKey(conversationId: string, attachmentId: string, name: string): string {
  return `conversations/${conversationId}/${attachmentId}/${safeName(name)}`;
}

export function maxBytesFor(contentType: string, maxAttachmentMb: number): number {
  const t = ALLOWED_TYPES[contentType];
  const mb = t?.maxMb ?? maxAttachmentMb;
  return Math.floor(Math.min(mb, maxAttachmentMb) * 1024 * 1024);
}
