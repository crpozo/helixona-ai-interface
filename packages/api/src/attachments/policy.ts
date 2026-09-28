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

const MiB = 1024 * 1024;

/**
 * Pages per attached PDF. Files that do not fit a request whole are read in parts (see READ), so the
 * cap is about time and cost, not about what one request can hold.
 */
export const MAX_PDF_PAGES = 1000;

/**
 * Documents sent to the model whole ("inline"). One request holds at most 32 MB (the PDF travels as
 * base64, a third larger) and 600 PDF pages, and each page costs about 3,000 tokens (text plus the page
 * image), so the documents of one request share a budget. Project files come first; attachments
 * then take what is left, oldest first, and whatever does not fit is read in parts instead.
 */
export const INLINE = {
  maxFileBytes: 15 * MiB,
  maxFilePages: 100,
  budgetBytes: 19 * MiB,
  budgetPages: 150,
  tokensPerPage: 3000,
} as const;

/**
 * Reading in parts: a PDF that does not go whole is transcribed a few pages at a time by a second
 * model, and the transcription (cached next to the file) goes into the conversation instead.
 */
export const READ = {
  /** Pages per request, fewer when the pages are heavy (scans). */
  chunkPages: 8,
  chunkTargetBytes: 8 * MiB,
  /** A part above this is split again; a single page above it cannot be read. */
  chunkMaxBytes: 20 * MiB,
  /** Pages that one message may send to be read (time and cost guard). */
  maxPagesPerTurn: 1500,
  /** Tokens a transcribed page takes in the conversation, for the context estimate before reading. */
  tokensPerPage: 600,
  /** Bumped when the transcription instructions change, so older transcriptions are redone. */
  version: "v1",
} as const;

/** Where the transcription of a file is kept: next to the file, so it follows its retention and deletion. */
export function readingPrefix(key: string): string {
  return `${key.slice(0, key.lastIndexOf("/"))}/reading-${READ.version}/`;
}

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

/** Knowledge files live under the project; deleting the project removes the prefix. */
export function projectKnowledgeKey(projectId: string, attachmentId: string, name: string): string {
  return `projects/${projectId}/${attachmentId}/${safeName(name)}`;
}

export const MAX_PROJECT_FILES = 20;
/** Project knowledge is sent with every turn of every conversation in the project: keep it well inside the context. */
export const MAX_PROJECT_KNOWLEDGE_TOKENS = 400_000;
/** Project files always go whole, so they keep the request-sized caps. */
export const MAX_KNOWLEDGE_FILE_MB = 20;
export const MAX_KNOWLEDGE_PDF_PAGES = 600;
export const MAX_PROJECT_KNOWLEDGE_BYTES = 18 * MiB;

export function maxBytesFor(contentType: string, maxAttachmentMb: number): number {
  const t = ALLOWED_TYPES[contentType];
  const mb = t?.maxMb ?? maxAttachmentMb;
  return Math.floor(Math.min(mb, maxAttachmentMb) * 1024 * 1024);
}
