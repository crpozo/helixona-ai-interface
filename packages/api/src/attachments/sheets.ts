import JSZip from "jszip";

/**
 * Spreadsheets attached to a conversation (CSV and Excel .xlsx): read into rows of text, the way
 * Excel shows them, so the model can see them with their Excel row numbers and the browser can copy
 * rows into a workbook exactly as they are in the file. Parsing is done here, without formulas or
 * macros being run: only the stored values are read.
 */

export interface SheetTable {
  name: string;
  /** Rows as displayed text; the first row is Excel row 1. */
  rows: string[][];
  /** Rows left out because the sheet is longer than the cap. */
  truncatedRows: number;
}

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const SHEET_LIMITS = {
  /** Rows read per sheet (the rest are counted, not read). */
  maxRows: 20_000,
  maxCols: 200,
  maxCellChars: 4_000,
  maxSheets: 50,
  /** A part of the workbook (a sheet, the shared strings) larger than this is refused: a zip bomb guard. A 10 MB report inflates to about 100 MB of XML. */
  maxPartBytes: 160 * 1024 * 1024,
  maxTotalBytes: 320 * 1024 * 1024,
} as const;

/** The file cannot be read as a spreadsheet (maps to a 400 the person can fix). */
export class SpreadsheetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadsheetError";
  }
}

export function isSpreadsheet(contentType: string): boolean {
  return contentType === XLSX_TYPE || contentType === "text/csv";
}

// ---------------------------------------------------------------- CSV

/** RFC 4180 CSV (quotes, doubled quotes, line breaks inside quotes, CRLF), with a byte-order mark removed. */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  // A file saved as "CSV" by some systems is tab- or semicolon-separated.
  const sep = firstLine.includes(",") ? "," : firstLine.includes("\t") ? "\t" : firstLine.includes(";") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------------------------------------------------------------- XLSX

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITY[e] ?? "";
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  return m ? unescapeXml(m[2] ?? m[3] ?? "") : null;
}

/** The text of every <t> element in a fragment, skipping phonetic runs (<rPh>). */
function textOf(fragment: string): string {
  const withoutPhonetic = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) out += unescapeXml(m[1] ?? "");
  return out;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

/** Built-in number formats that show a date or time (Excel's ids). */
const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
const BUILTIN_CODE: Record<number, string> = {
  0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 5: "$#,##0", 6: "$#,##0", 7: "$#,##0.00", 8: "$#,##0.00",
  9: "0%", 10: "0.00%", 11: "0.00E+00", 37: "#,##0", 38: "#,##0", 39: "#,##0.00", 40: "#,##0.00",
  41: "#,##0", 42: "$#,##0", 43: "#,##0.00", 44: "$#,##0.00", 48: "##0.0E+0", 49: "@",
};

interface NumberFormat {
  kind: "general" | "date" | "number" | "percent" | "text";
  decimals: number;
  thousands: boolean;
  currency: boolean;
  /** For dates: whether the format shows the day and the time. */
  hasDate: boolean;
  hasTime: boolean;
}

/** The part of a format code that decides how a number looks (quoted text, colors and conditions removed). */
function bareCode(code: string): string {
  return (code.split(";")[0] ?? "").replace(/"([^"]*)"/g, (_m, q: string) => (q.includes("$") ? "$" : "")).replace(/\[[^\]]*\]/g, (m) => (/^\[\$[^-\]]*/.test(m) ? "$" : "")).replace(/\\./g, "").replace(/_.|\*./g, "");
}

function describeFormat(id: number, custom: Map<number, string>): NumberFormat {
  const code = custom.get(id) ?? BUILTIN_CODE[id] ?? (BUILTIN_DATE.has(id) ? "m/d/yyyy" : "General");
  const bare = bareCode(code);
  const base: NumberFormat = { kind: "general", decimals: 0, thousands: false, currency: false, hasDate: false, hasTime: false };
  if (BUILTIN_DATE.has(id) && !custom.has(id)) {
    const hasTime = (id >= 18 && id <= 22) || (id >= 45 && id <= 47);
    return { ...base, kind: "date", hasDate: !hasTime || id === 22, hasTime };
  }
  if (/[dmyhs]/i.test(bare) && !/[0#?]/.test(bare) && !/General/i.test(bare)) {
    const hasTime = /[hs]/i.test(bare) || /am\/pm/i.test(code);
    const hasDate = /[dy]/i.test(bare) || (!hasTime && /m/i.test(bare)) || (id >= 14 && id <= 17) || id === 22;
    return { ...base, kind: "date", hasDate: hasDate || !hasTime, hasTime };
  }
  if (code === "@") return { ...base, kind: "text" };
  if (/General/i.test(bare) || !/[0#?]/.test(bare)) return base;
  const decimals = (/\.([0#?]+)/.exec(bare)?.[1] ?? "").length;
  const percent = bare.includes("%");
  return { ...base, kind: percent ? "percent" : "number", decimals, thousands: /[0#?],[0#?]/.test(bare), currency: bare.includes("$") };
}

function plainNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return String(Number.parseFloat(v.toPrecision(15)));
}

function withThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A date serial number as Excel shows it in the US: M/D/YYYY, with the time when the format has one. */
function serialToText(serial: number, date1904: boolean, fmt: NumberFormat): string {
  let days = serial;
  if (date1904) days += 1462;
  else if (days < 60) days += 1; // Excel's 1900 leap-year bug: serials before March 1, 1900 are one day off
  const ms = Math.round((days - 25569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return plainNumber(serial);
  const date = `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  if (!fmt.hasTime) return date;
  const h = d.getUTCHours();
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  return fmt.hasDate ? `${date} ${time}` : time;
}

function formatNumber(v: number, fmt: NumberFormat, date1904: boolean): string {
  switch (fmt.kind) {
    case "date":
      return serialToText(v, date1904, fmt);
    case "percent": {
      const n = (v * 100).toFixed(fmt.decimals);
      return `${fmt.thousands ? withThousands(n.split(".")[0]!) + (n.includes(".") ? "." + n.split(".")[1] : "") : n}%`;
    }
    case "number": {
      const abs = Math.abs(v).toFixed(fmt.decimals);
      const [int, dec] = abs.split(".");
      const body = `${fmt.thousands ? withThousands(int!) : int}${dec !== undefined ? "." + dec : ""}`;
      return `${v < 0 ? "-" : ""}${fmt.currency ? "$" : ""}${body}`;
    }
    default:
      return plainNumber(v);
  }
}

async function part(zip: JSZip, path: string, budget: { used: number }): Promise<string | null> {
  const file = zip.file(path);
  if (!file) return null;
  const declared = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof declared === "number" && declared > SHEET_LIMITS.maxPartBytes) throw new SpreadsheetError("This workbook has a sheet too large to read. Save the rows you need in a smaller file, or as CSV.");
  const text = await file.async("string");
  budget.used += text.length;
  if (text.length > SHEET_LIMITS.maxPartBytes || budget.used > SHEET_LIMITS.maxTotalBytes) throw new SpreadsheetError("This workbook is too large to read. Save the rows you need in a smaller file, or as CSV.");
  return text;
}

function resolveTarget(target: string): string {
  const t = target.replace(/^\/+/, "");
  return t.startsWith("xl/") ? t : `xl/${t.replace(/^\.\//, "")}`;
}

/** The visible sheets of an .xlsx workbook, as displayed text. */
export async function parseXlsx(bytes: Uint8Array): Promise<SheetTable[]> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new SpreadsheetError("This file could not be opened as an Excel workbook. Save it again as .xlsx or CSV and attach that.");
  }
  const budget = { used: 0 };
  const workbook = await part(zip, "xl/workbook.xml", budget);
  if (!workbook) throw new SpreadsheetError("This file could not be opened as an Excel workbook. Save it again as .xlsx or CSV and attach that.");
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](1|true)["']/.test(workbook);

  const rels = new Map<string, string>();
  for (const m of (await part(zip, "xl/_rels/workbook.xml.rels", budget) ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) rels.set(id, resolveTarget(target));
  }

  const shared: string[] = [];
  const sst = await part(zip, "xl/sharedStrings.xml", budget);
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(textOf(m[1] ?? ""));

  const custom = new Map<number, string>();
  const styleFormats: number[] = [];
  const styles = await part(zip, "xl/styles.xml", budget);
  if (styles) {
    for (const m of styles.matchAll(/<numFmt\b[^>]*\/?>/g)) {
      const id = Number(attr(m[0], "numFmtId"));
      const code = attr(m[0], "formatCode");
      if (Number.isFinite(id) && code !== null) custom.set(id, code);
    }
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
    for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) styleFormats.push(Number(attr(m[0], "numFmtId") ?? 0));
  }
  const formatCache = new Map<number, NumberFormat>();
  const formatFor = (style: number): NumberFormat => {
    const id = styleFormats[style] ?? 0;
    let f = formatCache.get(id);
    if (!f) formatCache.set(id, (f = describeFormat(id, custom)));
    return f;
  };

  const sheets: SheetTable[] = [];
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    if (sheets.length >= SHEET_LIMITS.maxSheets) break;
    const state = attr(m[0], "state");
    if (state === "hidden" || state === "veryHidden") continue;
    const name = attr(m[0], "name") ?? `Sheet${sheets.length + 1}`;
    const rid = attr(m[0], "r:id");
    const path = rid ? rels.get(rid) : undefined;
    if (!path) continue;
    const xml = await part(zip, path, budget);
    if (xml === null) continue;
    sheets.push(readSheet(name, xml, shared, formatFor, date1904));
  }
  if (sheets.length === 0) throw new SpreadsheetError("This workbook has no visible sheet to read.");
  return sheets;
}

function readSheet(name: string, xml: string, shared: string[], formatFor: (style: number) => NumberFormat, date1904: boolean): SheetTable {
  const rows: string[][] = [];
  let truncated = 0;
  let nextRow = 1;
  const data = /<sheetData\b[^>]*>([\s\S]*)<\/sheetData>/.exec(xml)?.[1] ?? "";
  for (const rm of data.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rowAttrs = rm[1] ?? rm[3] ?? "";
    const r = Number(attr(`<row ${rowAttrs}>`, "r") ?? nextRow);
    nextRow = r + 1;
    if (r > SHEET_LIMITS.maxRows) {
      truncated++;
      continue;
    }
    const cells: string[] = [];
    let nextCol = 0;
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c ${cm[1] ?? ""}>`;
      const ref = attr(tag, "r");
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      if (col < 0 || col >= SHEET_LIMITS.maxCols) continue;
      const body = cm[2] ?? "";
      const type = attr(tag, "t") ?? "n";
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = "";
      if (type === "s") text = raw !== undefined ? shared[Number(raw)] ?? "" : "";
      else if (type === "inlineStr") text = textOf(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "");
      else if (type === "b") text = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
      else if (type === "str" || type === "e") text = unescapeXml(raw ?? "");
      else if (type === "d") text = unescapeXml(raw ?? "");
      else if (raw !== undefined && raw !== "") {
        const v = Number(raw);
        text = Number.isFinite(v) ? formatNumber(v, formatFor(Number(attr(tag, "s") ?? 0)), date1904) : unescapeXml(raw);
      }
      if (text.length > SHEET_LIMITS.maxCellChars) text = text.slice(0, SHEET_LIMITS.maxCellChars);
      while (cells.length < col) cells.push("");
      cells[col] = text;
    }
    while (rows.length < r - 1) rows.push([]);
    rows[r - 1] = cells;
  }
  return { name, rows: trim(rows), truncatedRows: truncated };
}

/** Drops trailing empty cells and rows, and pads rows to the same width. */
function trim(rows: string[][]): string[][] {
  const clean = rows.map((r) => {
    const out = [...r];
    while (out.length > 0 && out[out.length - 1] === "") out.pop();
    return out;
  });
  while (clean.length > 0 && clean[clean.length - 1]!.length === 0) clean.pop();
  const width = clean.reduce((n, r) => Math.max(n, r.length), 0);
  return clean.map((r) => (r.length < width ? [...r, ...Array<string>(width - r.length).fill("")] : r));
}

// ---------------------------------------------------------------- both

/** The sheets of an attached spreadsheet. */
export async function readTables(contentType: string, bytes: Uint8Array): Promise<SheetTable[]> {
  if (contentType === XLSX_TYPE) return parseXlsx(bytes);
  const rows = trim(parseCsv(Buffer.from(bytes).toString("utf8")).map((r) => r.map((c) => (c.length > SHEET_LIMITS.maxCellChars ? c.slice(0, SHEET_LIMITS.maxCellChars) : c))));
  const truncated = Math.max(0, rows.length - SHEET_LIMITS.maxRows);
  return [{ name: "Sheet1", rows: rows.slice(0, SHEET_LIMITS.maxRows), truncatedRows: truncated }];
}

export interface ModelText {
  text: string;
  /** Rows the model sees (the header rows included) and rows left out. */
  rows: number;
  rowsLeft: number;
}

/**
 * The spreadsheet as the model reads it: each sheet as CSV with a first column, Row, holding the
 * Excel row number (the header is row 1), so an answer can point to rows the way staff see them.
 * A file longer than `maxChars` is cut: each sheet keeps its header and the share of the rows its
 * size earns, and its heading says how many rows are left out, so the model and staff know the
 * view is partial.
 */
export function fitForModel(fileName: string, tables: SheetTable[], maxChars = Infinity): ModelText {
  const sheets = tables.map((t) => {
    // The first line (row 1, usually the header) is labelled "Row"; the others carry their row number.
    const lines = t.rows.map((r, i) => [i === 0 ? "Row" : String(i + 1), ...r].map(csvCell).join(","));
    return { t, lines, chars: lines.reduce((n, l) => n + l.length + 1, 0) };
  });
  const total = sheets.reduce((n, s) => n + s.chars, 0);
  const parts: string[] = [];
  let rows = 0;
  let rowsLeft = 0;
  for (const s of sheets) {
    const budget = total <= maxChars ? Infinity : Math.floor((maxChars * s.chars) / total);
    let used = 0;
    let n = 0;
    while (n < s.lines.length && (n === 0 || used + s.lines[n]!.length + 1 <= budget)) {
      used += s.lines[n]!.length + 1;
      n++;
    }
    const cut = s.lines.length - n;
    const left = cut + s.t.truncatedRows;
    rows += n;
    rowsLeft += left;
    const why = cut > 0 ? "the file is too long for one conversation" : "the sheet is too long";
    const head = `Sheet "${s.t.name}" of "${fileName}": ${n.toLocaleString("en-US")} rows${left > 0 ? `; ${left.toLocaleString("en-US")} more rows are not shown because ${why} (ask for a file with only the rows and columns needed, or split it)` : ""}.`;
    parts.push([head, ...s.lines.slice(0, n)].join("\n"));
  }
  return { text: parts.join("\n\n"), rows, rowsLeft };
}

export function tablesForModel(fileName: string, tables: SheetTable[], maxChars = Infinity): string {
  return fitForModel(fileName, tables, maxChars).text;
}
