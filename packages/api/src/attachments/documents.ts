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

export async function pdfPageCount(bytes: Buffer): Promise<number | null> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return null; // unreadable by pdf-lib: let the model try, the size cap still applies
  }
}

/** PDFs go to the model natively (base64); text files as plain-text documents. `cache` marks a prompt-cache breakpoint. */
export function documentBlock(meta: AttachmentMeta, bytes: Buffer, cache: boolean): BetaContentBlockParam {
  const block =
    meta.contentType === "application/pdf"
      ? { type: "document" as const, title: meta.name, source: { type: "base64" as const, media_type: "application/pdf" as const, data: bytes.toString("base64") } }
      : { type: "document" as const, title: meta.name, source: { type: "text" as const, media_type: "text/plain" as const, data: bytes.toString("utf8") } };
  return (cache ? { ...block, cache_control: { type: "ephemeral", ttl: "1h" } } : block) as BetaContentBlockParam;
}

/** Verifies an object the browser uploaded (exists, allowed type, size, page count) and returns its metadata and bytes. */
export async function verifyUpload(store: AttachmentStore, key: string, id: string, rawName: string, maxAttachmentMb: number): Promise<{ meta: AttachmentMeta; bytes: Buffer }> {
  const name = safeName(rawName);
  const head = await store.head(key);
  if (!head) throw new AttachmentProblem("attachment_missing", `The file "${name}" was not uploaded`);
  const contentType = head.contentType && ALLOWED_TYPES[head.contentType] ? head.contentType : name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain";
  if (head.size > maxBytesFor(contentType, maxAttachmentMb)) throw new AttachmentProblem("file_too_large", `The file "${name}" is too large`);
  const bytes = await store.get(key);
  const pages = contentType === "application/pdf" ? await pdfPageCount(bytes) : null;
  if (pages !== null && pages > MAX_PDF_PAGES) throw new AttachmentProblem("too_many_pages", `"${name}" has ${pages} pages; PDFs are limited to ${MAX_PDF_PAGES} pages each. Please split the document.`);
  return { meta: { id, name, contentType, size: head.size, pages, key }, bytes };
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
