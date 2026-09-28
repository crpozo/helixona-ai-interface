import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { cellValue, expandFileRefs, markdownToXlsxBlob, parseRowList, sheetNames, workbookModel, type FileTables } from "./workbook";

const checks: FileTables = {
  name: "Checks May.xlsx",
  sheets: [
    {
      name: "Checks",
      truncatedRows: 0,
      rows: [
        ["Patient", "Check #", "Amount", "Status", "Note"],
        ["Ana Pérez", "000981", "$1,234.50", "Cashed", "paid *twice* | call"],
        ["Luis <Jr>", "100234", "-$20.00", "Outstanding", "R&B"],
        ["Mia_Lee", "100235", "$15.00", "Cashed", "a\\b"],
      ],
    },
    { name: "May", truncatedRows: 0, rows: [["Only"], ["x"]] },
  ],
};
const resolve = async (name: string) => (name.toLowerCase().startsWith("checks may") ? checks : null);

describe("Rows copied from an attached spreadsheet", () => {
  it("reads row lists the way people write them", () => {
    expect(parseRowList("2-5, 9, 12–14; 9")).toEqual([2, 3, 4, 5, 9, 12, 13, 14]);
    expect(parseRowList("7 3")).toEqual([7, 3]);
  });

  it("replaces a reference with the whole sheet or the chosen rows, exactly as they are in the file", async () => {
    const md = "# Follow-up\n\n## Original data\n\n{{file: Checks May.xlsx}}\n\n## Cashed\n{{ file: checks may | rows: 4, 2 }}\n## Other sheet\n{{file: Checks May.xlsx | sheet: may}}";
    const { markdown, problems } = await expandFileRefs(md, resolve);
    expect(problems).toEqual([]);
    const model = workbookModel(markdown, "Follow-up");
    expect(model.map((s) => s.name)).toEqual(["Original data", "Cashed", "Other sheet"]);
    // Markdown characters in the data come back as the same text.
    expect(model[0]!.tables[0]).toEqual(checks.sheets[0]!.rows);
    expect(model[1]!.tables[0]).toEqual([checks.sheets[0]!.rows[0], checks.sheets[0]!.rows[3], checks.sheets[0]!.rows[1]]);
    expect(model[2]!.tables[0]).toEqual([["Only"], ["x"]]);
  });

  it("says what could not be copied instead of guessing", async () => {
    const { markdown, problems } = await expandFileRefs("## A\n{{file: Payments.csv}}\n## B\n{{file: Checks May.xlsx | rows: 3, 40}}\n## C\n{{file: Checks May.xlsx | sheet: June}}", resolve);
    expect(problems).toEqual([
      'The rows of "Payments.csv" could not be loaded: attach the spreadsheet to this conversation (Excel or CSV).',
      'Rows 40 are not in "Checks May.xlsx".',
      '"Checks May.xlsx" has no sheet named "June".',
    ]);
    expect(markdown).toContain("could not be loaded");
    expect(workbookModel(markdown, "x")[1]!.tables[0]).toHaveLength(2);
  });
});

describe("Excel workbooks", () => {
  it("keeps amounts and plain numbers as numbers, and anything that could lose information as text", () => {
    expect(cellValue("$1,234.50")).toEqual({ kind: "number", value: 1234.5, style: 2 });
    expect(cellValue("-$20.00")).toEqual({ kind: "number", value: -20, style: 2 });
    expect(cellValue("($20.00)")).toEqual({ kind: "number", value: -20, style: 2 });
    expect(cellValue("1,234")).toEqual({ kind: "number", value: 1234, style: 4 });
    expect(cellValue("100234")).toEqual({ kind: "number", value: 100234, style: 0 });
    expect(cellValue("12.5")).toEqual({ kind: "number", value: 12.5, style: 0 });
    for (const text of ["000981", "123456789012", "1/15/2026", "12.5%", "ABC-12", "=SUM(A1)", ""]) expect(cellValue(text)).toEqual({ kind: "text", text });
  });

  it("names tabs the way Excel allows", () => {
    expect(sheetNames(["Cashed / never cashed?", "Cashed \\ never cashed:", "", "A very long name that goes beyond thirty-one characters"])).toEqual([
      "Cashed never cashed",
      "Cashed never cashed (2)",
      "Sheet3",
      "A very long name that goes beyo",
    ]);
  });

  it("builds a real .xlsx: one tab per section, notes above the table, the header frozen and filtered, typed cells", async () => {
    const md =
      "# Check follow-up\n\nPrepared from Checks May.xlsx.\n\n## Cashed by patient\n\n| Patient | Check # | Amount |\n| --- | --- | --- |\n| Ana & Co | 000981 | $1,234.50 |\n| Luis | 100234 | $20.00 |\n\n## Summary\n\n- Two checks cashed\n\n| Tab | Rows |\n| --- | --- |\n| Cashed | 2 |";
    const blob = await markdownToXlsxBlob(md, "Check follow-up");
    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const workbook = await zip.file("xl/workbook.xml")!.async("string");
    expect([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(["Cashed by patient", "Summary"]);
    expect(workbook).toContain(`<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Cashed by patient'!$A$3:$C$5</definedName>`);
    const sheet1 = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet1).toContain(`<c r="A1" t="inlineStr" s="5"><is><t xml:space="preserve">Prepared from Checks May.xlsx.</t></is></c>`);
    expect(sheet1).toContain(`<c r="A3" t="inlineStr" s="1"><is><t xml:space="preserve">Patient</t></is></c>`);
    expect(sheet1).toContain(`<c r="A4" t="inlineStr"><is><t xml:space="preserve">Ana &amp; Co</t></is></c>`);
    expect(sheet1).toContain(`<c r="B4" t="inlineStr"><is><t xml:space="preserve">000981</t></is></c>`);
    expect(sheet1).toContain(`<c r="C4" s="2"><v>1234.5</v></c>`);
    expect(sheet1).toContain(`<pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/>`);
    expect(sheet1).toContain(`<autoFilter ref="A3:C5"/>`);
    const sheet2 = await zip.file("xl/worksheets/sheet2.xml")!.async("string");
    expect(sheet2).toContain("• Two checks cashed");
    expect(sheet2).toContain(`<c r="B4"><v>2</v></c>`);
    expect(await zip.file("[Content_Types].xml")!.async("string")).toContain("/xl/worksheets/sheet2.xml");
    expect(await zip.file("xl/styles.xml")!.async("string")).toContain(`formatCode="&quot;$&quot;#,##0.00"`);
  });
});
