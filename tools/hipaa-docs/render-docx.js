/** Renders a document tree from `lib.js` as a Word file (US Letter, Calibri, navy headings, gold accents). */
const {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, LevelFormat, Packer, PageNumber, Paragraph,
  ShadingType, Table, TableCell, TableRow, TextRun, WidthType, PageBreak, VerticalAlign,
} = require("docx");

const NAVY = "1F2A44";
const GOLD = "8C6D2E";
const GREY = "666666";
const LINE = "C9C9C9";
const HEADING = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 };
const HEADING_SPACING = { 1: { before: 360, after: 160 }, 2: { before: 280, after: 120 }, 3: { before: 200, after: 80 } };

function run(r, extra = {}) {
  if (typeof r === "string") return new TextRun({ text: r, ...extra });
  if (r.b !== undefined) return new TextRun({ text: r.b, bold: true, ...extra });
  return new TextRun({ text: r.i, italics: true, ...extra });
}
function cell(text, w, opts = {}) {
  const lines = Array.isArray(text) ? text : [text];
  return new TableCell({
    width: { size: w, type: WidthType.DXA },
    shading: opts.header ? { type: ShadingType.CLEAR, fill: NAVY, color: "auto" } : opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill, color: "auto" } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    verticalAlign: VerticalAlign.TOP,
    children: lines.map((l) => new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: l, bold: opts.header || opts.bold, color: opts.header ? "FFFFFF" : undefined, size: 18 })] })),
  });
}
function headerRow(cells, widths) {
  return new TableRow({ tableHeader: true, children: cells.map((t, k) => cell(t, widths[k], { header: true })) });
}
const spacer = () => new Paragraph({ spacing: { after: 120 }, children: [] });

let numInstance = 0;
function render(node) {
  switch (node.type) {
    case "title":
      return [
        new Paragraph({ spacing: { before: 2400, after: 120 }, children: [new TextRun({ text: "HELIXONA", bold: true, color: GOLD, size: 22, characterSpacing: 60 })] }),
        new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: node.title, bold: true, size: 48, color: NAVY })] }),
        new Paragraph({ spacing: { after: 600 }, children: [new TextRun({ text: node.subtitle, size: 26, color: GREY })] }),
        render({ type: "kv", rows: node.meta, widths: [2600, 6760] }),
        spacer(),
      ];
    case "h":
      return new Paragraph({ heading: HEADING[node.level], spacing: HEADING_SPACING[node.level], children: [new TextRun(node.text)] });
    case "p": {
      const { type: _type, runs, align, ...style } = node;
      return new Paragraph({ spacing: { after: 120, line: 276 }, alignment: align, children: runs.map((r) => run(r, style)) });
    }
    case "note":
      return new Paragraph({
        spacing: { after: 120 },
        shading: { type: ShadingType.CLEAR, fill: "F3EFE4", color: "auto" },
        border: { left: { style: BorderStyle.SINGLE, size: 18, color: GOLD, space: 8 } },
        children: [new TextRun({ text: node.text, size: 20, color: "333333" })],
      });
    case "list": {
      const numbering = node.ordered ? { reference: "numbers", level: 0, instance: ++numInstance } : { reference: "bullets", level: 0 };
      return node.items.map((item) => new Paragraph({ numbering, spacing: { after: 60, line: 276 }, children: item.map((r) => run(r)) }));
    }
    case "table":
      return new Table({
        width: { size: node.widths.reduce((a, c) => a + c, 0), type: WidthType.DXA },
        columnWidths: node.widths,
        rows: [
          headerRow(node.headers, node.widths),
          ...node.rows.map((r, ri) => new TableRow({ children: r.map((c, k) => cell(c, node.widths[k], { fill: ri % 2 ? "F7F7F7" : undefined, bold: k === 0 && r.length > 2 })) })),
        ],
      });
    case "kv":
      return new Table({
        width: { size: node.widths[0] + node.widths[1], type: WidthType.DXA },
        columnWidths: node.widths,
        rows: node.rows.map((r) => new TableRow({ children: [cell(r[0], node.widths[0], { fill: "EFEFEF", bold: true }), cell(r[1], node.widths[1])] })),
      });
    case "signatures": {
      const w = [3400, 3600, 2360];
      return new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: w,
        rows: [
          headerRow(["Name and role", "Signature", "Date"], w),
          ...node.roles.map((r) => new TableRow({ height: { value: 700, rule: "atLeast" }, children: [cell(r, w[0]), cell("", w[1]), cell("", w[2])] })),
        ],
      });
    }
    case "spacer":
      return spacer();
    case "pageBreak":
      return new Paragraph({ children: [new PageBreak()] });
    default:
      throw new Error(`Unknown node type: ${node.type}`);
  }
}

/** Returns the .docx file as a Buffer. `runningTitle` appears in the page header. */
function renderDocx(doc) {
  numInstance = 0;
  const runningTitle = doc.runningTitle ?? doc.title;
  const document = new Document({
    creator: "Helixona",
    title: runningTitle,
    styles: {
      default: { document: { run: { font: "Calibri", size: 22 } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 32, bold: true, color: NAVY, font: "Calibri" }, paragraph: { outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 26, bold: true, color: NAVY, font: "Calibri" }, paragraph: { outlineLevel: 1 } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 22, bold: true, color: GOLD, font: "Calibri" }, paragraph: { outlineLevel: 2 } },
      ],
    },
    numbering: {
      config: [
        { reference: "bullets", levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
        { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }] },
      ],
    },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      headers: { default: new Header({ children: [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LINE, space: 4 } }, children: [new TextRun({ text: "Helixona  |  " + runningTitle, size: 16, color: GREY })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Confidential. Internal use only.   Page ", size: 16, color: GREY }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GREY }), new TextRun({ text: " of ", size: 16, color: GREY }), new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: GREY })] })] }) },
      children: doc.children.flatMap(render),
    }],
  });
  return Packer.toBuffer(document);
}

module.exports = { renderDocx };
