import type { PhrasingContent, RootContent, Table } from "mdast";
import { expandDocumentNodes, inlinePlainText, parseMarkdown } from "./markdownExport";
import { applyRule, applyRuleOption, describeRule, emptyRule, hasRule, type TableRule } from "./tableQuery";

/**
 * Spreadsheets the assistant prepares: an Excel workbook (.xlsx) with one tab per section of the
 * document, built in the browser (nothing is sent anywhere). Rows that come from a spreadsheet the
 * person attached are not retyped by the model: it writes a reference such as
 *
 *     {{file: Checks.xlsx}}                       the whole sheet, exactly as in the file
 *     {{file: Checks.xlsx | rows: 2-5, 9}}        the header row and those Excel rows
 *     {{file: Checks.xlsx | sheet: May | rows: 4}}
 *
 * and the browser replaces it with the rows read from the file itself, so names, amounts and dates
 * are the original ones.
 */

// ---------------------------------------------------------------- references to attached files

export interface FileSheet {
  name: string;
  rows: string[][];
  truncatedRows: number;
}
export interface FileTables {
  name: string;
  sheets: FileSheet[];
}
/** Finds an attached spreadsheet by the name the model used; null when there is none. */
export type ResolveFile = (fileName: string) => Promise<FileTables | null>;

/** A fresh pattern each time: a shared global RegExp keeps its position between calls. */
const refLine = () => /^[ \t]*\{\{\s*file\s*:\s*([^}\n]*?)\s*\}\}[ \t]*$/gm;

export function hasFileRefs(markdown: string): boolean {
  return refLine().test(markdown);
}

interface FileRef {
  file: string;
  sheet: string | null;
  rows: string | null;
  /** A filter, grouping, total or sort to compute over the rows (see tableQuery.ts). */
  rule: TableRule;
  /** Options that could not be read, named back in a note. */
  unknown: string[];
}

export function parseRef(inner: string): FileRef {
  const [file = "", ...opts] = inner.split("|").map((s) => s.trim());
  const ref: FileRef = { file, sheet: null, rows: null, rule: emptyRule(), unknown: [] };
  for (const o of opts) {
    if (!o) continue;
    const m = /^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/s.exec(o) ?? (/^count$/i.test(o) ? ["", "count", ""] : null);
    if (!m) {
      ref.unknown.push(o);
      continue;
    }
    const key = m[1]!.trim().toLowerCase();
    if (key === "sheet" || key === "tab") ref.sheet = m[2]!.trim();
    else if (key === "row" || key === "rows") ref.rows = m[2]!.trim();
    else if (!applyRuleOption(ref.rule, key, m[2]!)) ref.unknown.push(o);
  }
  return ref;
}

/** "2-5, 9, 12–14" → [2,3,4,5,9,12,13,14] (Excel row numbers, in the order given, without repeats). */
export function parseRowList(spec: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const part of spec.split(/[,;\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let r = Math.min(a, b); r <= Math.max(a, b) && out.length < 1_048_576; r++) {
      if (!seen.has(r)) {
        seen.add(r);
        out.push(r);
      }
    }
  }
  return out;
}

/** A cell as Markdown text that reads back as exactly the same text. */
function mdCell(s: string): string {
  return s.replace(/\r?\n|\r/g, " ").replace(/[\\`*_[\]<>|~&]/g, (c) => `\\${c}`);
}

function markdownTable(rows: string[][]): string {
  const width = rows.reduce((n, r) => Math.max(n, r.length), 1);
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => mdCell(r[i] ?? "")).join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

/** The same attached file, allowing for letter case and a missing extension. */
export function fileNameMatches(a: string, b: string): boolean {
  return sameFile(a, b);
}

function sameFile(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase();
  const stem = (s: string) => norm(s).replace(/\.[a-z0-9]+$/, "");
  return a === b || norm(a) === norm(b) || stem(a) === stem(b);
}

/**
 * Replaces each file reference with a Markdown table of the rows it names, read from the attached
 * file. A reference that cannot be resolved becomes a visible note, and is listed in `problems`.
 */
export async function expandFileRefs(markdown: string, resolve: ResolveFile): Promise<{ markdown: string; problems: string[] }> {
  const problems: string[] = [];
  const refs = [...markdown.matchAll(refLine())];
  if (refs.length === 0) return { markdown, problems };
  const files = new Map<string, Promise<FileTables | null>>();
  const tables = await Promise.all(
    refs.map(async (m) => {
      const ref = parseRef(m[1] ?? "");
      const note = (why: string) => {
        problems.push(why);
        return `*[${why}]*`;
      };
      if (!ref.file) return note("A reference to an attached file has no file name.");
      if (!files.has(ref.file)) files.set(ref.file, resolve(ref.file).catch(() => null));
      const file = await files.get(ref.file)!;
      if (!file) return note(`The rows of "${ref.file}" could not be loaded: attach the spreadsheet to this conversation (Excel or CSV).`);
      const sheet = ref.sheet ? file.sheets.find((s) => sameFile(s.name, ref.sheet!)) : file.sheets[0];
      if (!sheet) return note(`"${file.name}" has no sheet named "${ref.sheet}".`);
      if (sheet.rows.length === 0) return note(`The sheet "${sheet.name}" of "${file.name}" is empty.`);
      if (ref.unknown.length > 0) problems.push(`In a reference to "${file.name}", this was not understood and was ignored: ${ref.unknown.join("; ")}.`);
      let data = sheet.rows.slice(1);
      if (ref.rows) {
        const wanted = parseRowList(ref.rows).filter((r) => r !== 1);
        const missing = wanted.filter((r) => r > sheet.rows.length);
        if (missing.length > 0) problems.push(`Rows ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""} are not in "${file.name}".`);
        data = wanted.filter((r) => r <= sheet.rows.length).map((r) => sheet.rows[r - 1]!);
      }
      if (!hasRule(ref.rule)) return markdownTable([sheet.rows[0]!, ...data]);
      // A rule is computed here over the whole file, so it holds even for rows the model never saw.
      const result = applyRule(sheet.rows[0]!, data, ref.rule, file.name);
      if (result.rows.length === 0) return note(`The rule for "${file.name}" (${describeRule(ref.rule)}) could not be applied: ${result.problems.join(" ")}`);
      problems.push(...result.problems);
      return markdownTable(result.rows);
    }),
  );
  let i = 0;
  // Blank lines around each table so it is read as a table, whatever surrounds the reference.
  const out = markdown.replace(refLine(), () => `\n${tables[i++]}\n`);
  return { markdown: out, problems };
}

// ---------------------------------------------------------------- the workbook model

interface SheetModel {
  name: string;
  notes: string[];
  tables: string[][][];
}

function tableRows(t: Table): string[][] {
  return t.children.map((row) => row.children.map((c) => inlinePlainText(c.children as PhrasingContent[])));
}

function blockLines(n: RootContent): string[] {
  switch (n.type) {
    case "paragraph":
      return [inlinePlainText(n.children)];
    case "heading":
      return [inlinePlainText(n.children)];
    case "list":
      return n.children.flatMap((item, i) => {
        const inner = item.children.flatMap(blockLines).join(" ");
        return [`${n.ordered ? `${(n.start ?? 1) + i}.` : "•"} ${inner}`];
      });
    case "blockquote":
      return n.children.flatMap(blockLines);
    case "code":
      return n.value.split("\n");
    default:
      return [];
  }
}

/** The document's sections as sheets: each level-2 heading starts a tab named after it. */
export function workbookModel(markdown: string, title: string): SheetModel[] {
  const nodes = expandDocumentNodes(parseMarkdown(markdown).children);
  const lead: SheetModel = { name: title, notes: [], tables: [] };
  const sheets: SheetModel[] = [];
  let current = lead;
  for (const n of nodes) {
    if (n.type === "heading" && n.depth === 1) continue;
    if (n.type === "heading" && n.depth === 2) {
      current = { name: inlinePlainText(n.children), notes: [], tables: [] };
      sheets.push(current);
      continue;
    }
    if (n.type === "table") current.tables.push(tableRows(n));
    else current.notes.push(...blockLines(n).filter((l) => l.trim() !== ""));
  }
  // Text before the first section goes on top of the first tab, unless it has tables of its own.
  if (lead.tables.length > 0 || sheets.length === 0) sheets.unshift(lead);
  else if (lead.notes.length > 0) sheets[0]!.notes.unshift(...lead.notes);
  return sheets.filter((s) => s.tables.length > 0 || s.notes.length > 0);
}

/** Excel's rules for tab names: 31 characters, none of []:*?/\, not blank, unique (case-insensitive). */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw, i) => {
    const base = raw.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || `Sheet${i + 1}`;
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base.slice(0, 31 - ` (${k})`.length)} (${k})`;
    used.add(name.toLowerCase());
    return name;
  });
}

// ---------------------------------------------------------------- cells

type Cell = { kind: "text"; text: string } | { kind: "number"; value: number; style: number };

const STYLE = { normal: 0, header: 1, currency: 2, decimals: 3, thousands: 4, note: 5 } as const;

/**
 * A value as Excel should hold it: amounts and plain numbers as numbers (so they sum and sort), with
 * the look they had; anything that could lose information stays text (leading zeros, long ids,
 * dates, percentages, codes).
 */
export function cellValue(text: string): Cell {
  const t = text.trim();
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const core = t.replace(/^\(|\)$/g, "").replace(/^-/, "");
  const money = /^\$\s?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.exec(core);
  if (money) {
    const v = Number(core.replace(/[$,\s]/g, ""));
    if (Number.isFinite(v)) return { kind: "number", value: neg ? -v : v, style: STYLE.currency };
  }
  if (/^(\d{1,3}(,\d{3})+)(\.\d+)?$/.test(core) && !t.startsWith("(")) {
    const v = Number(core.replace(/,/g, ""));
    if (Number.isFinite(v)) return { kind: "number", value: neg ? -v : v, style: core.includes(".") ? STYLE.decimals : STYLE.thousands };
  }
  // Plain numbers: no leading zeros, at most 11 digits before the point (Excel shows longer ones in
  // scientific notation), at most 15 significant digits.
  if (/^-?(0|[1-9]\d{0,10})(\.\d{1,9})?$/.test(t)) {
    const v = Number(t);
    if (Number.isFinite(v) && t.replace(/[-.]/g, "").length <= 15) return { kind: "number", value: v, style: STYLE.normal };
  }
  return { kind: "text", text };
}

// ---------------------------------------------------------------- XML

const xmlEscape = (s: string) =>
  s
    // Characters XML 1.0 does not allow.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

interface BuiltSheet {
  xml: string;
  /** The filtered range of the first table, e.g. A3:F40, or null. */
  filter: string | null;
}

function sheetXml(sheet: SheetModel): BuiltSheet {
  const rows: string[] = [];
  let r = 0;
  let filter: string | null = null;
  let headerRow = 0;
  const widths: number[] = [];
  const addRow = (cells: string[]) => rows.push(`<row r="${r}">${cells.join("")}</row>`);
  const textCell = (c: number, text: string, style: number) =>
    `<c r="${colName(c)}${r}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;

  for (const note of sheet.notes) {
    r++;
    addRow([textCell(0, note, STYLE.note)]);
  }
  if (sheet.notes.length > 0 && sheet.tables.length > 0) r++;
  sheet.tables.forEach((table, ti) => {
    if (ti > 0) r++;
    const width = table.reduce((n, row) => Math.max(n, row.length), 0);
    const first = r + 1;
    table.forEach((row, ri) => {
      r++;
      const cells = Array.from({ length: width }, (_, c) => {
        const text = row[c] ?? "";
        widths[c] = Math.max(widths[c] ?? 0, Math.min(60, text.length));
        if (ri === 0) return textCell(c, text, STYLE.header);
        if (text === "") return "";
        const v = cellValue(text);
        return v.kind === "number" ? `<c r="${colName(c)}${r}"${v.style ? ` s="${v.style}"` : ""}><v>${v.value}</v></c>` : textCell(c, v.text, STYLE.normal);
      });
      addRow(cells);
    });
    if (ti === 0 && width > 0) {
      headerRow = first;
      filter = `A${first}:${colName(width - 1)}${Math.max(first, r)}`;
    }
  });

  const pane = headerRow > 0 ? `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${headerRow + 1}" sqref="A${headerRow + 1}"/>` : "";
  const cols = widths.length > 0 ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(8, w + 2)}" customWidth="1"/>`).join("")}</cols>` : "";
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols}` +
    `<sheetData>${rows.join("")}</sheetData>` +
    (filter ? `<autoFilter ref="${filter}"/>` : "") +
    `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    `</worksheet>`;
  return { xml, filter };
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>` +
  `<fonts count="3">` +
  `<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="11"/><color rgb="FF1F2A44"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><i/><sz val="11"/><color rgb="FF595959"/><name val="Calibri"/><family val="2"/></font>` +
  `</fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3EFE6"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFC9B27A"/></bottom><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="6">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

/** The document as an Excel workbook: one tab per section, the first table of each tab with a filter and a frozen header. */
export async function markdownToXlsxBlob(markdown: string, title: string): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const model = workbookModel(markdown, title);
  const sheets = model.length > 0 ? model : [{ name: title, notes: [], tables: [] }];
  const names = sheetNames(sheets.map((s) => s.name));
  const built = sheets.map(sheetXml);
  const zip = new JSZip();
  const quote = (name: string) => `'${name.replace(/'/g, "''")}'`;
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      built.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  const defined = built
    .map((b, i) => (b.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlEscape(quote(names[i]!))}!${b.filter.replace(/([A-Z]+)(\d+)/g, "$$$1$$$2")}</definedName>` : ""))
    .join("");
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="16000" windowHeight="9000"/></bookViews>` +
      `<sheets>${names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
      (defined ? `<definedNames>${defined}</definedNames>` : "") +
      `</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      built.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
      `<Relationship Id="rId${built.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      `</Relationships>`,
  );
  zip.file("xl/styles.xml", STYLES_XML);
  built.forEach((b, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, b.xml));
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", compression: "DEFLATE" });
}

/** True when the document has at least one table (a spreadsheet needs one). */
export function hasTables(markdown: string): boolean {
  return expandDocumentNodes(parseMarkdown(markdown).children).some((n) => n.type === "table");
}
