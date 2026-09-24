import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { List, PhrasingContent, Root, RootContent, Table } from "mdast";
import type { Document as DocxDocument, Paragraph as DocxParagraph, Table as DocxTable } from "docx";

/**
 * The assistant's reply, taken out of the app: as formatted text for the clipboard (Word,
 * eClinicalWorks and Outlook read the HTML flavour; plain editors get the text flavour) and as a
 * Word document. Everything is built in the browser from the reply's Markdown; nothing is sent
 * anywhere or stored.
 */

/** The reply as a syntax tree (GitHub flavour: tables, strikethrough, task lists). */
export function parseMarkdown(text: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(text) as Root;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const safeUrl = (url: string) => /^(https?:|mailto:|tel:)/i.test(url.trim());

// ---- HTML (clipboard) ----

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
  return nodes
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

function blockText(nodes: RootContent[], indent = ""): string[] {
  const out: string[] = [];
  for (const n of nodes) {
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

// ---- Word ----

type Style = { bold?: boolean; italics?: boolean; strike?: boolean };

/** The reply as a Word document (Calibri 11, headings, bullets and numbers, tables with borders). */
export async function markdownToDocx(text: string): Promise<DocxDocument> {
  const { AlignmentType, BorderStyle, Document, ExternalHyperlink, HeadingLevel, LevelFormat, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
  const border = { style: BorderStyle.SINGLE, size: 4, color: "999999" };
  let numberedLists = 0;

  const runs = (nodes: PhrasingContent[], style: Style = {}): (InstanceType<typeof TextRun> | InstanceType<typeof ExternalHyperlink>)[] =>
    nodes.flatMap((n) => {
      switch (n.type) {
        case "text":
          return [new TextRun({ text: n.value, bold: style.bold, italics: style.italics, strike: style.strike })];
        case "strong":
          return runs(n.children, { ...style, bold: true });
        case "emphasis":
          return runs(n.children, { ...style, italics: true });
        case "delete":
          return runs(n.children, { ...style, strike: true });
        case "inlineCode":
          return [new TextRun({ text: n.value, font: "Consolas", bold: style.bold, italics: style.italics })];
        case "break":
          return [new TextRun({ break: 1 })];
        case "link":
          return safeUrl(n.url) ? [new ExternalHyperlink({ link: n.url, children: [new TextRun({ text: inlineText(n.children), style: "Hyperlink" })] })] : runs(n.children, style);
        case "html":
          return [new TextRun({ text: n.value })];
        case "image":
          return [new TextRun({ text: n.alt ?? "" })];
        case "linkReference":
          return runs(n.children, style);
        default:
          return [];
      }
    });

  const blocks = (nodes: RootContent[], level = 0, indent = 0): (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] =>
    nodes.flatMap((n) => {
      switch (n.type) {
        case "heading":
          return [new Paragraph({ heading: HEADINGS[Math.min(n.depth, 6) - 1], children: runs(n.children) })];
        case "paragraph":
          return [new Paragraph({ children: runs(n.children), spacing: { after: 120 }, ...(indent ? { indent: { left: indent } } : {}) })];
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
              children: n.value.split("\n").flatMap((line, i) => [...(i ? [new TextRun({ break: 1 })] : []), new TextRun({ text: line, font: "Consolas", size: 20 })]),
              shading: { type: ShadingType.CLEAR, fill: "F2F2F2" },
              spacing: { after: 120 },
            }),
          ];
        case "thematicBreak":
          return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 1 } }, spacing: { after: 120 } })];
        case "table": {
          const columns = Math.max(...n.children.map((r) => r.children.length), 1);
          const rows = n.children.map(
            (row, i) =>
              new TableRow({
                tableHeader: i === 0,
                children: Array.from({ length: columns }, (_, c) => {
                  const cell = row.children[c];
                  return new TableCell({
                    borders: { top: border, bottom: border, left: border, right: border },
                    ...(i === 0 ? { shading: { type: ShadingType.CLEAR, fill: "E7E6E6" } } : {}),
                    margins: { top: 60, bottom: 60, left: 100, right: 100 },
                    children: [new Paragraph({ children: cell ? runs(cell.children, { bold: i === 0 }) : [] })],
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

  const heading = (id: string, name: string, size: number) => ({
    id,
    name,
    basedOn: "Normal",
    next: "Normal",
    quickFormat: true,
    run: { size, bold: true, color: "1F2A44", font: "Calibri" },
    paragraph: { spacing: { before: 240, after: 100 } },
  });

  return new Document({
    creator: "Helixona Assistant",
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
      paragraphStyles: [heading("Heading1", "Heading 1", 32), heading("Heading2", "Heading 2", 28), heading("Heading3", "Heading 3", 24)],
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
    sections: [{ children: blocks(parseMarkdown(text).children) as (DocxParagraph | DocxTable)[] }],
  });
}

export async function markdownToDocxBlob(text: string): Promise<Blob> {
  const { Packer } = await import("docx");
  return Packer.toBlob(await markdownToDocx(text));
}

/** A file name Word and Windows accept, from the conversation's title. */
export function docxFileName(title: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${safe || "Helixona response"}.docx`;
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
