import { PDFDocument } from "pdf-lib";
import type { AttachmentMeta, BetaContentBlockParam } from "@helixona/core";
import type { AttachmentStore } from "./store.js";
import { ALLOWED_TYPES, MAX_PDF_PAGES, maxBytesFor, safeName } from "./policy.js";

/** A problem with an uploaded file that the client can fix (maps to a 400). */
export class AttachmentProblem extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AttachmentProblem";
  }
}

export interface PdfInfo {
  /** Null when pdf-lib cannot parse the file (the model may still read it). */
  pages: number | null;
  /** Password-protected (even with an empty open password): pdf-lib cannot split it into parts. */
  encrypted: boolean;
}

export async function pdfInfo(bytes: Uint8Array): Promise<PdfInfo> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return { pages: doc.getPageCount(), encrypted: doc.isEncrypted };
  } catch {
    return { pages: null, encrypted: false }; // unreadable by pdf-lib: let the model try, the size cap still applies
  }
}

export async function pdfPageCount(bytes: Buffer): Promise<number | null> {
  return (await pdfInfo(bytes)).pages;
}

/** PDFs go to the model natively (base64); text files as plain-text documents. `cache` marks a prompt-cache breakpoint. */
export function documentBlock(meta: AttachmentMeta, bytes: Buffer, cache: boolean): BetaContentBlockParam {
  const block =
    meta.contentType === "application/pdf"
      ? { type: "document" as const, title: meta.name, source: { type: "base64" as const, media_type: "application/pdf" as const, data: bytes.toString("base64") } }
      : { type: "document" as const, title: meta.name, source: { type: "text" as const, media_type: "text/plain" as const, data: bytes.toString("utf8") } };
  return (cache ? { ...block, cache_control: { type: "ephemeral", ttl: "1h" } } : block) as BetaContentBlockParam;
}

/**
 * A PDF that was too large to send whole, as the transcription the server made of it page by page.
 * The context tells the model what it is looking at and asks it to cite pages, so staff can check a
 * value against the original.
 */
export function readingBlock(meta: AttachmentMeta, text: string, failedPages: string[], cache: boolean): BetaContentBlockParam {
  const size = meta.pages ? `${meta.pages}-page ` : "";
  const missing = failedPages.length > 0 ? ` These pages could not be read and are missing: ${failedPages.join(", ")}; say so if they matter for the answer.` : "";
  const block = {
    type: "document" as const,
    title: meta.name,
    context: `Transcription of a ${size}PDF made page by page by the assistant, because the file was too large to send whole. Each page starts with "(p. N)". The values were copied from the page images: when you use one, cite the file and the page so staff can check it against the original.${missing}`,
    source: { type: "text" as const, media_type: "text/plain" as const, data: text },
  };
  return (cache ? { ...block, cache_control: { type: "ephemeral", ttl: "1h" } } : block) as BetaContentBlockParam;
}

/**
 * Quick check of an object the browser uploaded, before the reply stream starts: it exists, its type
 * and size are allowed, and a PDF starts like one. Pages are counted later (the file may be large).
 */
export async function checkUpload(store: AttachmentStore, key: string, id: string, rawName: string, maxAttachmentMb: number): Promise<AttachmentMeta> {
  const name = safeName(rawName);
  const head = await store.head(key);
  if (!head) throw new AttachmentProblem("attachment_missing", `The file "${name}" was not uploaded`);
  const contentType = head.contentType && ALLOWED_TYPES[head.contentType] ? head.contentType : name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain";
  if (head.size > maxBytesFor(contentType, maxAttachmentMb)) throw new AttachmentProblem("file_too_large", `The file "${name}" is too large`);
  if (contentType === "application/pdf") {
    const start = await store.getRange(key, 0, 1023);
    if (!start.includes("%PDF-")) throw new AttachmentProblem("not_a_pdf", `"${name}" is not a PDF file. Open it and save it as PDF, then attach it again.`);
  }
  return { id, name, contentType, size: head.size, pages: null, key };
}

/** Downloads a PDF only to count its pages; the bytes are dropped right away. */
export async function inspectPdf(store: AttachmentStore, key: string): Promise<PdfInfo> {
  return pdfInfo(await store.get(key));
}

/** Full check for files that always go whole (project knowledge): type, size, page count within `maxPages`. */
export async function inspectUpload(store: AttachmentStore, key: string, id: string, rawName: string, maxAttachmentMb: number, maxPages = MAX_PDF_PAGES): Promise<AttachmentMeta> {
  const meta = await checkUpload(store, key, id, rawName, maxAttachmentMb);
  if (meta.contentType !== "application/pdf") return meta;
  const { pages } = await inspectPdf(store, key);
  if (pages !== null && pages > maxPages) throw new AttachmentProblem("too_many_pages", `"${meta.name}" has ${pages} pages; files here are limited to ${maxPages} pages each. Please split the document.`);
  return { ...meta, pages };
}

/** Rebuilds document blocks from storage; a file that is gone becomes a short note instead of failing the turn. */
export async function loadDocumentBlocks(store: AttachmentStore, metas: AttachmentMeta[], cacheLast: boolean): Promise<BetaContentBlockParam[]> {
  const blocks: BetaContentBlockParam[] = [];
  for (const [i, meta] of metas.entries()) {
    try {
      blocks.push(documentBlock(meta, await store.get(meta.key), cacheLast && i === metas.length - 1));
    } catch {
      blocks.push({ type: "text", text: `[Attachment "${meta.name}" is no longer available]` });
    }
  }
  return blocks;
}
