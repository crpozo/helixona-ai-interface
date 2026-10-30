/** File helpers shared by the composer and the message bubbles. */

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const ZIP_TYPE = "application/zip";

const EXT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  xlsx: XLSX_TYPE,
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  zip: ZIP_TYPE,
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
/** Browsers name a ZIP either way. */
const TYPE_ALIASES: Record<string, string> = { "application/x-zip-compressed": ZIP_TYPE };

/** What the file pickers offer: the types the server reads, and a ZIP (uploaded as one file; the assistant reads inside it). */
export const ATTACH_ACCEPT = `.pdf,.xlsx,.csv,.txt,.md,.zip,.png,.jpg,.jpeg,.gif,.webp,application/pdf,${XLSX_TYPE},text/csv,text/plain,text/markdown,application/zip,application/x-zip-compressed,image/png,image/jpeg,image/gif,image/webp`;
export const ATTACH_TYPES_TEXT = "PDF, Excel, CSV, TXT, MD, ZIP or an image (PNG, JPEG, GIF, WebP)";
/** Project files: what the server reads for every message of a project (no ZIPs, no images). */
export const KNOWLEDGE_ACCEPT = `.pdf,.xlsx,.csv,.txt,.md,application/pdf,${XLSX_TYPE},text/csv,text/plain,text/markdown`;
export const KNOWLEDGE_TYPES_TEXT = "PDF, Excel, CSV, TXT or MD";

export function isImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

/** Size cap for a type, as on the server: PDFs and ZIPs up to the configured limit, Excel 10 MB, text files and images 5 MB. */
export function maxMbFor(contentType: string, maxMb: number): number {
  if (contentType === "application/pdf" || contentType === ZIP_TYPE) return maxMb;
  return Math.min(maxMb, contentType === XLSX_TYPE ? 10 : 5);
}

/** A ZIP: one attachment whose files the assistant reads in parts, with tools. */
export function isZipType(contentType: string): boolean {
  return contentType === ZIP_TYPE;
}

/** Spreadsheets the assistant can copy rows from. */
export function isSpreadsheetType(contentType: string): boolean {
  return contentType === XLSX_TYPE || contentType === "text/csv";
}

/** MIME type the API accepts for this file, derived from the extension first (browsers often send blanks). */
export function attachmentType(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (EXT_TYPES[ext]) return EXT_TYPES[ext];
  const type = TYPE_ALIASES[file.type] ?? file.type;
  return Object.values(EXT_TYPES).includes(type) ? type : null;
}

/**
 * Mirrors the server's budget for documents sent whole (attachments/policy.ts INLINE): above it, PDFs
 * are read page by page before the answer, which takes longer. Used only to tell the user so.
 */
const WHOLE_FILE_BYTES = 15 * 1048576;
const WHOLE_TOTAL_BYTES = 19 * 1048576;

export function readsPageByPage(files: Array<{ contentType: string; size: number }>): boolean {
  const pdfs = files.filter((f) => f.contentType === "application/pdf");
  return pdfs.some((f) => f.size > WHOLE_FILE_BYTES) || pdfs.reduce((n, f) => n + f.size, 0) > WHOLE_TOTAL_BYTES;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
