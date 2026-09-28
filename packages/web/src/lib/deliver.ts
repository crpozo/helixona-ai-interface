import { downloadBlob, markdownToCsv, markdownToDocxBlob, markdownToPlain, printMarkdownDocument, safeFileName, type DocFormat } from "./markdownExport";
import { hasTables, markdownToXlsxBlob } from "./workbook";

/** Short names for buttons ("Download Excel", "Also as Word · PDF"). */
export const FORMAT_LABEL: Record<DocFormat, string> = { word: "Word", pdf: "PDF", xlsx: "Excel", txt: "Text", csv: "CSV" };
export const FORMATS: DocFormat[] = ["word", "pdf", "xlsx", "txt", "csv"];

/** Spreadsheet formats need at least one table. */
export function needsTable(format: DocFormat): boolean {
  return format === "xlsx" || format === "csv";
}

export class NoTableError extends Error {
  constructor() {
    super("This document has no table to put in a spreadsheet.");
    this.name = "NoTableError";
  }
}

/** Downloads (or, for PDF, prints) the document in a format; built in the browser, nothing is sent. */
export async function deliverDocument(markdown: string, format: DocFormat, title: string): Promise<void> {
  const base = safeFileName(title);
  if (needsTable(format) && !hasTables(markdown)) throw new NoTableError();
  switch (format) {
    case "word":
      return downloadBlob(await markdownToDocxBlob(markdown), `${base}.docx`);
    case "pdf":
      return printMarkdownDocument(markdown, title);
    case "xlsx":
      return downloadBlob(await markdownToXlsxBlob(markdown, title), `${base}.xlsx`);
    case "txt":
      return downloadBlob(new Blob([markdownToPlain(markdown)], { type: "text/plain;charset=utf-8" }), `${base}.txt`);
    case "csv":
      return downloadBlob(new Blob([markdownToCsv(markdown) ?? ""], { type: "text/csv;charset=utf-8" }), `${base}.csv`);
  }
}
