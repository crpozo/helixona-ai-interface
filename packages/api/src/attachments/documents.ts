import { PDFDocument } from "pdf-lib";
import type { AttachmentMeta, BetaContentBlockParam } from "@helixona/core";
import type { AttachmentStore } from "./store.js";
import { ALLOWED_TYPES, MAX_PDF_PAGES, maxBytesFor, safeName } from "./policy.js";
import { fitForModel, isSpreadsheet, readTables, SpreadsheetError, tablesForModel, XLSX_TYPE } from "./sheets.js";
import { isZipType, loadZipIndex, prepareZip, ZIP_TYPE, ZipProblem } from "./zips.js";

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

/** Where the rows of a spreadsheet, as the model reads them, are kept: next to the file, so they go with it. */
export function sheetTextKey(meta: AttachmentMeta): string {
  return meta.key.replace(/\/[^/]*$/, "/sheet-text-v1.txt");
}

/** The widest a spreadsheet's text may be when no budget is given (the cap of `sheetCharBudget`). */
const DEFAULT_SHEET_CHARS = 2_000_000;

/**
 * The text the model receives for a spreadsheet (CSV or Excel): every visible sheet as CSV with its
 * Excel row numbers, cut to `maxChars`. Read from the file once (when it is attached), then kept next
 * to it, so later turns do not reopen the workbook. With `bytes`, the file is read now.
 */
export async function spreadsheetText(store: AttachmentStore, meta: AttachmentMeta, maxChars: number, bytes?: Buffer): Promise<string> {
  if (!bytes) {
    try {
      return (await store.get(sheetTextKey(meta))).toString("utf8");
    } catch {
      bytes = await store.get(meta.key); // not prepared yet (an older attachment): read the file
    }
  }
  const text = tablesForModel(meta.name, await readTables(meta.contentType, bytes), maxChars);
  await store.put(sheetTextKey(meta), Buffer.from(text, "utf8"), "text/plain").catch(() => undefined);
  return text;
}

/**
 * A spreadsheet as a document block, so an answer can point to rows and the browser can copy those
 * rows from the file exactly. A missing file throws (the caller says it is gone); a file that cannot
 * be read as a spreadsheet becomes a note.
 */
export async function spreadsheetBlock(store: AttachmentStore, meta: AttachmentMeta, cache: boolean, maxChars = DEFAULT_SHEET_CHARS): Promise<BetaContentBlockParam> {
  let block: Record<string, unknown>;
  try {
    block = {
      type: "document",
      title: meta.name,
      context: `Spreadsheet attached by staff, read by the assistant. The first column, Row, is the Excel row number (row 1 is usually the header); it is not part of the file. Use these numbers to point to rows. When the heading of a sheet says rows are not shown, the interface still has every row and computes {{file: …}} references over all of them; say in the answer that the figures come from the whole file.`,
      source: { type: "text", media_type: "text/plain", data: await spreadsheetText(store, meta, maxChars) },
    };
  } catch (e) {
    if (!(e instanceof SpreadsheetError)) throw e;
    block = { type: "text", text: `[Attachment "${meta.name}" could not be read as a spreadsheet: ${e.message}]` };
  }
  return (cache ? { ...block, cache_control: { type: "ephemeral", ttl: "1h" } } : block) as unknown as BetaContentBlockParam;
}

/**
 * A ZIP goes to the model as the list of what is inside, not as its contents: the model reads the
 * files it needs with the ZIP tools, in parts. A missing file throws (the caller says it is gone).
 */
export async function zipBlock(store: AttachmentStore, meta: AttachmentMeta, cache: boolean): Promise<BetaContentBlockParam> {
  let block: Record<string, unknown>;
  try {
    const { manifest } = await loadZipIndex(store, meta);
    block = {
      type: "document",
      title: meta.name,
      context: "A ZIP archive attached by staff. This is only the list of the files inside it, not their contents. Read what the question needs with the tools: search_zip_files to find which files mention something, list_zip_files to see one folder or kind of file, read_zip_files to get the contents of up to 20 files per call. Work in parts: look first, then read the files that matter, several per call, then answer. Name the files you used, and never describe or quote a file you have not read.",
      source: { type: "text", media_type: "text/plain", data: manifest },
    };
  } catch (e) {
    if (!(e instanceof ZipProblem)) throw e;
    block = { type: "text", text: `[Attachment "${meta.name}" ${e.message}]` };
  }
  return (cache ? { ...block, cache_control: { type: "ephemeral", ttl: "1h" } } : block) as unknown as BetaContentBlockParam;
}

/** The block for any attached file sent whole: a PDF, a spreadsheet, a text file, or the file list of a ZIP. */
export async function contentBlock(store: AttachmentStore, meta: AttachmentMeta, cache: boolean, maxSheetChars = DEFAULT_SHEET_CHARS): Promise<BetaContentBlockParam> {
  if (isZipType(meta.contentType)) return zipBlock(store, meta, cache);
  return isSpreadsheet(meta.contentType) ? spreadsheetBlock(store, meta, cache, maxSheetChars) : documentBlock(meta, await store.get(meta.key), cache);
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
export async function checkUpload(store: AttachmentStore, key: string, id: string, rawName: string, maxAttachmentMb: number, sheetChars = DEFAULT_SHEET_CHARS): Promise<AttachmentMeta> {
  const name = safeName(rawName);
  const head = await store.head(key);
  if (!head) throw new AttachmentProblem("attachment_missing", `The file "${name}" was not uploaded`);
  const lower = name.toLowerCase();
  const declared = head.contentType && ALLOWED_TYPES[head.contentType] ? head.contentType : lower.endsWith(".pdf") ? "application/pdf" : lower.endsWith(".xlsx") ? XLSX_TYPE : lower.endsWith(".csv") ? "text/csv" : lower.endsWith(".zip") ? ZIP_TYPE : "text/plain";
  const contentType = isZipType(declared) ? ZIP_TYPE : declared;
  if (head.size > maxBytesFor(contentType, maxAttachmentMb)) throw new AttachmentProblem("file_too_large", `The file "${name}" is too large`);
  if (contentType === "application/pdf") {
    const start = await store.getRange(key, 0, 1023);
    if (!start.includes("%PDF-")) throw new AttachmentProblem("not_a_pdf", `"${name}" is not a PDF file. Open it and save it as PDF, then attach it again.`);
  }
  const meta: AttachmentMeta = { id, name, contentType, size: head.size, pages: null, key };
  if (isZipType(contentType)) {
    // Opened once, now: what is inside is listed and kept next to the file; the model reads from it with tools.
    try {
      const { index, manifest } = await prepareZip(store, meta, await store.get(key));
      return { ...meta, modelChars: manifest.length, zip: { files: index.files, readable: index.readable, bytes: index.bytes } };
    } catch (e) {
      if (e instanceof ZipProblem) throw new AttachmentProblem(e.code, `"${name}" ${e.message}.`);
      throw e;
    }
  }
  if (isSpreadsheet(contentType)) {
    // Read now, once: a file that is not a workbook (an old .xls renamed, a damaged file) is a plain
    // error, and the rows the model will see are kept next to the file, with their size.
    try {
      const tables = await readTables(contentType, await store.get(key));
      const fit = fitForModel(name, tables, sheetChars);
      await store.put(sheetTextKey(meta), Buffer.from(fit.text, "utf8"), "text/plain").catch(() => undefined);
      const rows = tables.reduce((n, t) => n + Math.max(0, t.rows.length - 1) + t.truncatedRows, 0);
      const columns = tables.reduce((n, t) => Math.max(n, t.rows[0]?.length ?? 0), 0);
      return { ...meta, modelChars: fit.text.length, sheet: { rows, columns, shown: Math.max(0, fit.rows - tables.length) } };
    } catch (e) {
      const why = e instanceof SpreadsheetError ? e.message : "Save it again as .xlsx or CSV and attach that.";
      throw new AttachmentProblem("not_a_spreadsheet", `"${name}": ${why}`);
    }
  }
  return meta;
}

/** Downloads a PDF only to count its pages; the bytes are dropped right away. */
export async function inspectPdf(store: AttachmentStore, key: string): Promise<PdfInfo> {
  return pdfInfo(await store.get(key));
}

/** Full check for files that always go whole (project knowledge): type, size, page count within `maxPages`. */
export async function inspectUpload(store: AttachmentStore, key: string, id: string, rawName: string, maxAttachmentMb: number, maxPages = MAX_PDF_PAGES, sheetChars = DEFAULT_SHEET_CHARS): Promise<AttachmentMeta> {
  const meta = await checkUpload(store, key, id, rawName, maxAttachmentMb, sheetChars);
  if (isZipType(meta.contentType)) throw new AttachmentProblem("unsupported_type", `"${meta.name}" is a ZIP: a project file is sent whole with every message. Attach the ZIP in a chat instead.`);
  if (meta.contentType !== "application/pdf") return meta;
  const { pages } = await inspectPdf(store, key);
  if (pages !== null && pages > maxPages) throw new AttachmentProblem("too_many_pages", `"${meta.name}" has ${pages} pages; files here are limited to ${maxPages} pages each. Please split the document.`);
  return { ...meta, pages };
}

/** Rebuilds document blocks from storage; a file that is gone becomes a short note instead of failing the turn. */
export async function loadDocumentBlocks(store: AttachmentStore, metas: AttachmentMeta[], cacheLast: boolean, maxSheetChars = DEFAULT_SHEET_CHARS): Promise<BetaContentBlockParam[]> {
  const blocks: BetaContentBlockParam[] = [];
  for (const [i, meta] of metas.entries()) {
    try {
      blocks.push(await contentBlock(store, meta, cacheLast && i === metas.length - 1, maxSheetChars));
    } catch {
      blocks.push({ type: "text", text: `[Attachment "${meta.name}" is no longer available]` });
    }
  }
  return blocks;
}
