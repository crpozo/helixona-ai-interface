import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { Packer } from "docx";
import { docxFileName, markdownToClipboardHtml, markdownToDocx, markdownToHtml, markdownToPlain } from "./markdownExport";

const sample = `# Lab summary

**CBC** drawn 09/20. *Stable* overall; see [source](https://example.test/labs) and <b>raw</b>.

| Test | Result | Range |
| --- | --- | --- |
| Hemoglobin | 13.2 g/dL | 12.0–16.0 |
| WBC | 11.8 | 4.0–11.0 |

- Mild leukocytosis
- Iron studies
  - Ferritin pending
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
  });

  it("names the file after the conversation, safely", () => {
    expect(docxFileName('Labs: John/Doe "Sept" <2026>?')).toBe("Labs John Doe Sept 2026.docx");
    expect(docxFileName("   ")).toBe("Helixona response.docx");
    expect(docxFileName("x".repeat(100))).toBe(`${"x".repeat(80)}.docx`);
  });
});
