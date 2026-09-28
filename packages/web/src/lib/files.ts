/** File helpers shared by the composer and the message bubbles. */

const EXT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
};

/** MIME type the API accepts for this file, derived from the extension first (browsers often send blanks). */
export function attachmentType(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (EXT_TYPES[ext]) return EXT_TYPES[ext];
  return Object.values(EXT_TYPES).includes(file.type) ? file.type : null;
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
