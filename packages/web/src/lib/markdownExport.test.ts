import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { Packer } from "docx";
import { docxFileName, documentFormatOf, documentTitle, markdownToClipboardHtml, markdownToCsv, markdownToDocx, markdownToHtml, markdownToPlain, markdownToPrintHtml, safeFileName } from "./markdownExport";

const sample = `# Lab summary

**CBC** drawn 09/20. *Stable* overall; see [source](https://example.test/labs) and <b>raw</b>.

| Test | Result | Range |
| --- | --- | --- |
| Hemoglobin | 13.2 g/dL | 12.0–16.0 |
| WBC | 11.8 | 4.0–11.0 |

- Mild leukocytosis
- Iron studies
  - Ferritin pending
## Plan

1. Repeat CBC in 2 weeks
2. Call if fever

> Reviewed before use.

\`\`\`
Free text block
\`\`\`
`;

describe("markdown export", () => {
  it("produces Word-friendly HTML: headings, a bordered table, nested lists, links only to web addresses", () => {
    const html = markdownToHtml(sample);
    expect(html).toContain("<h1>Lab summary</h1>");
    expect(html).toContain("<strong>CBC</strong>");
    expect(html).toContain('<a href="https://example.test/labs">source</a>');
    expect(html).toContain("&lt;b&gt;raw&lt;/b&gt;");
    expect(html).toContain('<table border="1"');
    expect(html).toContain("<th>Test</th>");
    expect(html).toContain("<td>13.2 g/dL</td>");
    expect(html).toContain("<ul><li>Mild leukocytosis</li><li>Iron studies<ul><li>Ferritin pending</li></ul></li></ul>");
    expect(html).toContain("<ol><li>Repeat CBC in 2 weeks</li>");
    expect(html).toContain("<blockquote><p>Reviewed before use.</p></blockquote>");
    expect(html).toContain("<pre>Free text block</pre>");
    expect(markdownToHtml("[x](javascript:alert(1))")).toBe("<p>x</p>");
    expect(markdownToClipboardHtml("Hi")).toMatch(/^<html>.*Calibri.*<p>Hi<\/p><\/body><\/html>$/s);
  });

  it("produces readable plain text: bullets, numbers, table rows, no Markdown marks", () => {
    const text = markdownToPlain(sample);
    expect(text).toContain("Lab summary\n\nCBC drawn 09/20. Stable overall; see source and <b>raw</b>.");
    expect(text).toContain("Test | Result | Range\nHemoglobin | 13.2 g/dL | 12.0–16.0");
    expect(text).toContain("• Mild leukocytosis\n• Iron studies\n   • Ferritin pending");
    expect(text).toContain("1. Repeat CBC in 2 weeks\n2. Call if fever");
    expect(text).toContain("> Reviewed before use.");
    expect(text).not.toContain("**");
    expect(text).not.toContain("#");
  });

  it("produces a Word document with headings, numbering, a table and the text", async () => {
    const buffer = await Packer.toBuffer(await markdownToDocx(sample));
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain('w:val="Heading1"');
    expect(xml).toContain("Lab summary");
    expect(xml).toContain("<w:tbl>");
    expect(xml).toContain("Hemoglobin");
    expect(xml).toContain("<w:numPr>");
    expect(xml).toContain("Ferritin pending");
    expect(xml).toContain("Repeat CBC in 2 weeks");
    expect(xml).toContain("<w:hyperlink ");
    expect(xml.includes("Free text block")).toBe(true);
    const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
    expect(rels).toContain("https://example.test/labs");
    // The letterhead line and the page number.
    const header = await zip.file("word/header1.xml")!.async("string");
    expect(header).toContain("HELIXONA");
    const footer = await zip.file("word/footer1.xml")!.async("string");
    expect(footer).toContain("PAGE");
    // Section headings carry the gold rule; tables a tinted header row.
    expect(xml).toContain("<w:pBdr>");
    expect(xml).toContain('w:fill="F3EFE6"');
    const styles = await zip.file("word/styles.xml")!.async("string");
    expect(styles).toContain("Georgia");
  });

  it("opens a document fence as content, finds its title, turns its tables into CSV and knows the formats", () => {
    const fenced = "Intro\n\n```document-pdf\n# Referral letter\n\nBody **bold**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n\nNote.";
    const html = markdownToHtml(fenced);
    expect(html).toContain("<h1>Referral letter</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).not.toContain("<pre>");
    expect(markdownToPlain(fenced)).toContain("Referral letter\n\nBody bold");
    expect(markdownToPrintHtml(fenced)).toMatch(/^<div class="print-doc-brand">HELIXONA<\/div><p>Intro<\/p>/);
    expect(documentTitle(fenced, "x")).toBe("Referral letter");
    expect(documentTitle("no heading here", "Conversation Sep 23")).toBe("Conversation Sep 23");
    expect(markdownToCsv(fenced)).toBe("\uFEFFA,B\n1,2");
    expect(markdownToCsv("plain")).toBeNull();
    expect(markdownToCsv('| Name | Note |\n| --- | --- |\n| Ana, MD | She said "ok" |')).toBe('\uFEFFName,Note\n"Ana, MD","She said ""ok"""');
    expect(documentFormatOf("language-document")).toBe("word");
    expect(documentFormatOf("language-document-pdf")).toBe("pdf");
    expect(documentFormatOf("language-document-csv")).toBe("csv");
    expect(documentFormatOf("language-json")).toBeNull();
    expect(documentFormatOf(undefined)).toBeNull();
    expect(safeFileName("Labs: 09/24")).toBe("Labs 09 24");
  });

  it("names the file after the conversation, safely", () => {
    expect(docxFileName('Labs: John/Doe "Sept" <2026>?')).toBe("Labs John Doe Sept 2026.docx");
    expect(docxFileName("   ")).toBe("Helixona response.docx");
    expect(docxFileName("x".repeat(100))).toBe(`${"x".repeat(80)}.docx`);
  });
});
