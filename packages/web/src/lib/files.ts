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

export function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
