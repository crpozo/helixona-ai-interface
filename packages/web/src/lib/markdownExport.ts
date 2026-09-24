import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { List, PhrasingContent, Root, RootContent, Table } from "mdast";
import type { Document as DocxDocument, Paragraph as DocxParagraph, Table as DocxTable } from "docx";

/**
 * The assistant's reply, taken out of the app: as formatted text for the clipboard (Word,
 * eClinicalWorks and Outlook read the HTML flavour; plain editors get the text flavour), as a Word
 * document, as a printed page (the browser's "Save as PDF"), as plain text, or as CSV for Excel.
 * Everything is built in the browser from the reply's Markdown; nothing is sent anywhere or stored.
 *
 * A reply that *is* a document arrives inside a fenced block whose language is `document` (Word),
 * `document-pdf`, `document-txt` or `document-csv`; the interface shows such a block as a file card.
 */

export type DocFormat = "word" | "pdf" | "txt" | "csv";

export const DOC_FORMAT_LABEL: Record<DocFormat, string> = { word: "Document · DOCX", pdf: "Document · PDF", txt: "Text · TXT", csv: "Spreadsheet · CSV" };

/** The format a document fence asks for, from the code element's class name; null for ordinary code. */
export function documentFormatOf(className: string | undefined): DocFormat | null {
  const m = /(?:^|\s)language-document(?:-(pdf|txt|csv|word))?(?:\s|$)/.exec(className ?? "");
  if (!m) return null;
  return (m[1] as DocFormat | undefined) ?? "word";
}

/** The reply as a syntax tree (GitHub flavour: tables, strikethrough, task lists). */
export function parseMarkdown(text: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(text) as Root;
}

/** The blocks of a tree, with any document fence opened up into the content it holds. */
function expand(nodes: RootContent[]): RootContent[] {
  return nodes.flatMap((n) => (n.type === "code" && n.lang && /^document(-\w+)?$/.test(n.lang) ? expand(parseMarkdown(n.value).children) : [n]));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const safeUrl = (url: string) => /^(https?:|mailto:|tel:)/i.test(url.trim());

// ---- Plain text pieces (also used for titles and CSV) ----

function inlineText(nodes: PhrasingContent[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
        case "inlineCode":
        case "html":
          return n.value;
        case "break":
          return "\n";
        case "image":
          return n.alt ?? "";
        default:
          return "children" in n ? inlineText(n.children as PhrasingContent[]) : "";
      }
    })
    .join("");
}

/** The document's title: its first level-1 heading, or the fallback (the conversation's title). */
export function documentTitle(text: string, fallback: string): string {
  const h1 = expand(parseMarkdown(text).children).find((n) => n.type === "heading" && n.depth === 1);
  const title = h1 && h1.type === "heading" ? inlineText(h1.children).trim() : "";
  return title || fallback;
}

// ---- HTML (clipboard and printing) ----

function inlineHtml(nodes: PhrasingContent[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
          return esc(n.value);
        case "strong":
          return `<strong>${inlineHtml(n.children)}</strong>`;
        case "emphasis":
          return `<em>${inlineHtml(n.children)}</em>`;
        case "delete":
          return `<s>${inlineHtml(n.children)}</s>`;
        case "inlineCode":
          return `<code>${esc(n.value)}</code>`;
        case "break":
          return "<br>";
        case "link":
          return safeUrl(n.url) ? `<a href="${esc(n.url)}">${inlineHtml(n.children)}</a>` : inlineHtml(n.children);
        case "html":
          // Raw HTML in a reply is shown as text on screen; the same here.
          return esc(n.value);
        case "image":
          return esc(n.alt ?? "");
        case "linkReference":
          return inlineHtml(n.children);
        default:
          return "";
      }
    })
    .join("");
}

function listHtml(list: List): string {
  const tag = list.ordered ? "ol" : "ul";
  const start = list.ordered && list.start && list.start !== 1 ? ` start="${list.start}"` : "";
  const items = list.children
    .map((item) => {
      const box = item.checked === true ? "☑ " : item.checked === false ? "☐ " : "";
      // A paragraph inside an item is inlined, so the list reads as a list and not as spaced paragraphs.
      const inner = item.children.map((c) => (c.type === "paragraph" ? inlineHtml(c.children) : blockHtml([c]))).join("");
      return `<li>${box}${inner}</li>`;
    })
    .join("");
  return `<${tag}${start}>${items}</${tag}>`;
}

function tableHtml(t: Table): string {
  const rows = t.children
    .map((row, i) => {
      const cell = i === 0 ? "th" : "td";
      return `<tr>${row.children.map((c) => `<${cell}>${inlineHtml(c.children)}</${cell}>`).join("")}</tr>`;
    })
    .join("");
  return `<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse">${rows}</table>`;
}

function blockHtml(nodes: RootContent[]): string {
  return expand(nodes)
    .map((n) => {
      switch (n.type) {
        case "heading": {
          const d = Math.min(n.depth, 6);
          return `<h${d}>${inlineHtml(n.children)}</h${d}>`;
        }
        case "paragraph":
          return `<p>${inlineHtml(n.children)}</p>`;
        case "list":
          return listHtml(n);
        case "blockquote":
          return `<blockquote>${blockHtml(n.children)}</blockquote>`;
        case "code":
          return `<pre>${esc(n.value)}</pre>`;
        case "thematicBreak":
          return "<hr>";
        case "table":
          return tableHtml(n);
        case "html":
          return `<p>${esc(n.value)}</p>`;
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n");
}

export function markdownToHtml(text: string): string {
  return blockHtml(parseMarkdown(text).children);
}

/** A whole HTML document for the clipboard, in the font Word and eClinicalWorks default to. */
export function markdownToClipboardHtml(text: string): string {
  return `<html><head><meta charset="utf-8"></head><body style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${markdownToHtml(text)}</body></html>`;
}

// ---- Plain text ----

function blockText(nodes: RootContent[], indent = ""): string[] {
  const out: string[] = [];
  for (const n of expand(nodes)) {
    switch (n.type) {
      case "heading":
      case "paragraph":
        out.push(indent + inlineText(n.children), "");
        break;
      case "list": {
        let i = n.start ?? 1;
        for (const item of n.children) {
          const marker = n.ordered ? `${i++}. ` : "• ";
          const box = item.checked === true ? "[x] " : item.checked === false ? "[ ] " : "";
          const deeper = indent + "   ";
          const parts: string[] = [];
          for (const c of item.children) {
            if (c.type === "paragraph") parts.push(inlineText(c.children));
            else parts.push(...blockText([c], deeper).filter((l) => l.trim() !== ""));
          }
          const [first = "", ...rest] = parts;
          out.push(`${indent}${marker}${box}${first}`, ...rest.map((l) => (l.startsWith(deeper) ? l : deeper + l)));
        }
        out.push("");
        break;
      }
      case "blockquote":
        out.push(...blockText(n.children, indent + "> "));
        break;
      case "code":
        out.push(...n.value.split("\n").map((l) => indent + l), "");
        break;
      case "thematicBreak":
        out.push(indent + "----------", "");
        break;
      case "table":
        for (const row of n.children) out.push(indent + row.children.map((c) => inlineText(c.children)).join(" | "));
        out.push("");
        break;
      case "html":
        out.push(indent + n.value, "");
        break;
      default:
        break;
    }
  }
  return out;
}

export function markdownToPlain(text: string): string {
  return blockText(parseMarkdown(text).children)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- CSV (the tables, for Excel) ----

/** The document's tables as CSV (UTF-8 with a byte-order mark, which Excel expects), or null when it has none. */
export function markdownToCsv(text: string): string | null {
  const tables = expand(parseMarkdown(text).children).filter((n): n is Table => n.type === "table");
  if (tables.length === 0) return null;
  const cell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return "﻿" + tables.map((t) => t.children.map((row) => row.children.map((c) => cell(inlineText(c.children))).join(",")).join("\n")).join("\n\n");
}

// ---- Word ----

const NAVY = "1F2A44";
const GOLD = "8C6D2E";
const GOLD_LINE = "C9B27A";
const GREY = "595959";
const LINE = "D9D9D9";
const TINT = "F3EFE6";

type Style = { bold?: boolean; italics?: boolean; strike?: boolean; lead?: boolean; color?: string };

/**
 * The reply as a Word document on the clinic's letterhead: a HELIXONA line with a gold rule, a serif
 * title with a lead paragraph, serif section headings with a gold rule, Calibri 11 body, bullets and
 * numbering, tables with a tinted header row, page numbers. US Letter, one-inch margins.
 */
export async function markdownToDocx(text: string): Promise<DocxDocument> {
  const { AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, Header, HeadingLevel, LevelFormat, PageNumber, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  let numberedLists = 0;

  const runs = (nodes: PhrasingContent[], style: Style = {}): (InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>)[] =>
    nodes.flatMap((n) => {
      const base = { bold: style.bold, italics: style.italics, strike: style.strike, ...(style.lead ? { size: 24, color: GREY } : {}), ...(style.color ? { color: style.color } : {}) };
      switch (n.type) {
        case "text":
          return [new TextRun({ text: n.value, ...base })];
        case "strong":
          return runs(n.children, { ...style, bold: true });
        case "emphasis":
          return runs(n.children, { ...style, italics: true });
        case "delete":
          return runs(n.children, { ...style, strike: true });
        case "inlineCode":
          return [new TextRun({ text: n.value, ...base, font: "Consolas" })];
        case "break":
          return [new TextRun({ break: 1 })];
        case "link":
          return safeUrl(n.url) ? [new ExternalHyperlink({ link: n.url, children: [new TextRun({ text: inlineText(n.children), style: "Hyperlink" })] })] : runs(n.children, style);
        case "html":
          return [new TextRun({ text: n.value, ...base })];
        case "image":
          return [new TextRun({ text: n.alt ?? "", ...base })];
        case "linkReference":
          return runs(n.children, style);
        default:
          return [];
      }
    });

  const blocks = (nodes: RootContent[], level = 0, indent = 0, top = false): (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] =>
    expand(nodes).flatMap((n, i, all) => {
      switch (n.type) {
        case "heading":
          return [
            new Paragraph({
              heading: HEADINGS[Math.min(n.depth, 6) - 1],
              children: runs(n.children),
              ...(n.depth === 2 ? { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GOLD_LINE, space: 3 } } } : {}),
            }),
          ];
        case "paragraph": {
          // The paragraph right under the title reads as its lead line, like a subtitle.
          const lead = top && i === 1 && all[0]?.type === "heading" && all[0].depth === 1;
          return [new Paragraph({ children: runs(n.children, lead ? { lead: true } : {}), spacing: { after: lead ? 240 : 120 }, ...(indent ? { indent: { left: indent } } : {}) })];
        }
        case "list": {
          const instance = n.ordered ? ++numberedLists : 0;
          const marker = n.ordered ? { numbering: { reference: "numbers", level, instance } } : { bullet: { level } };
          return n.children.flatMap((item) => {
            const box = item.checked === true ? "☑ " : item.checked === false ? "☐ " : "";
            const out: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
            let first = true;
            for (const c of item.children) {
              if (c.type === "paragraph") {
                out.push(
                  first
                    ? new Paragraph({ ...marker, children: [...(box ? [new TextRun({ text: box })] : []), ...runs(c.children)], spacing: { after: 60 } })
                    : new Paragraph({ children: runs(c.children), indent: { left: 720 * (level + 1) }, spacing: { after: 60 } }),
                );
                first = false;
              } else if (c.type === "list") {
                if (first) {
                  out.push(new Paragraph({ ...marker, children: [new TextRun({ text: box })] }));
                  first = false;
                }
                out.push(...blocks([c], level + 1, indent));
              } else {
                out.push(...blocks([c], level, 720 * (level + 1)));
              }
            }
            if (first) out.push(new Paragraph({ ...marker, children: [new TextRun({ text: box })] }));
            return out;
          });
        }
        case "blockquote":
          return blocks(n.children, level, indent + 720);
        case "code":
          return [
            new Paragraph({
              children: n.value.split("\n").flatMap((line, j) => [...(j ? [new TextRun({ break: 1 })] : []), new TextRun({ text: line, font: "Consolas", size: 20 })]),
              shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
              spacing: { after: 120 },
            }),
          ];
        case "thematicBreak":
          return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GOLD_LINE, space: 1 } }, spacing: { after: 120 } })];
        case "table": {
          const columns = Math.max(...n.children.map((r) => r.children.length), 1);
          const rows = n.children.map(
            (row, r) =>
              new TableRow({
                tableHeader: r === 0,
                cantSplit: true,
                children: Array.from({ length: columns }, (_, c) => {
                  const cell = row.children[c];
                  return new TableCell({
                    borders: { top: border, bottom: border, left: border, right: border },
                    ...(r === 0 ? { shading: { type: ShadingType.CLEAR, fill: TINT } } : {}),
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [new Paragraph({ children: cell ? runs(cell.children, r === 0 ? { bold: true, color: NAVY } : {}) : [] })],
                  });
                }),
              }),
          );
          return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }), new Paragraph({ spacing: { after: 60 } })];
        }
        case "html":
          return [new Paragraph({ children: [new TextRun({ text: n.value })] })];
        default:
          return [];
      }
    });

  const heading = (id: string, name: string, size: number, extra: { bold?: boolean; before: number; after: number }) => ({
    id,
    name,
    basedOn: "Normal",
    next: "Normal",
    quickFormat: true,
    run: { size, bold: extra.bold ?? false, color: NAVY, font: "Georgia" },
    paragraph: { spacing: { before: extra.before, after: extra.after }, keepNext: true },
  });

  return new Document({
    creator: "Helixona Assistant",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 }, paragraph: { spacing: { line: 276 } } } },
      paragraphStyles: [
        heading("Heading1", "Heading 1", 52, { before: 120, after: 120 }),
        heading("Heading2", "Heading 2", 30, { before: 360, after: 120 }),
        heading("Heading3", "Heading 3", 24, { bold: true, before: 240, after: 80 }),
      ],
    },
    numbering: {
      config: [
        {
          reference: "numbers",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GOLD, space: 4 } },
                spacing: { after: 240 },
                children: [new TextRun({ text: "HELIXONA", font: "Georgia", size: 20, color: GOLD, characterSpacing: 80 }), new TextRun({ text: "   Integrative medicine · Irvine, California", font: "Calibri", size: 16, color: GREY })],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Page ", size: 16, color: GREY }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GREY })] })],
          }),
        },
        children: blocks(parseMarkdown(text).children, 0, 0, true) as (DocxParagraph | DocxTable)[],
      },
    ],
  });
}

export async function markdownToDocxBlob(text: string): Promise<Blob> {
  const { Packer } = await import("docx");
  return Packer.toBlob(await markdownToDocx(text));
}

// ---- Files and the clipboard ----

/** A file name Word and Windows accept, from a title. */
export function safeFileName(title: string, fallback = "Helixona document"): string {
  const safe = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return safe || fallback;
}

export function docxFileName(title: string): string {
  return `${safeFileName(title, "Helixona response")}.docx`;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The document as HTML for the page's print stylesheet (the letterhead line, then the content). */
export function markdownToPrintHtml(text: string): string {
  return `<div class="print-doc-brand">HELIXONA</div>${markdownToHtml(text)}`;
}

/**
 * Prints the document alone, styled by the print stylesheet, through the browser's print dialog,
 * where "Save as PDF" is one of the destinations. The page title becomes the PDF's default name.
 */
export function printMarkdownDocument(text: string, title: string): void {
  const host = document.createElement("div");
  host.className = "print-doc doc-paper";
  host.innerHTML = markdownToPrintHtml(text);
  const previousTitle = document.title;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    host.remove();
    document.body.classList.remove("printing-doc");
    document.title = previousTitle;
    window.removeEventListener("afterprint", done);
  };
  document.body.appendChild(host);
  document.body.classList.add("printing-doc");
  document.title = title;
  window.addEventListener("afterprint", done);
  try {
    window.print();
  } finally {
    // Browsers that never fire afterprint, or a dialog that never opened: tidy up regardless.
    window.setTimeout(done, 120_000);
  }
}

/**
 * Puts the reply on the clipboard in both flavours: formatted (HTML) for Word, eClinicalWorks and
 * email, plain text for everything else. Falls back to plain text where the rich API is missing.
 */
export async function copyFormatted(html: string, text: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      return true;
    }
  } catch {
    // Some browsers refuse the rich flavour; the plain one below still helps.
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
