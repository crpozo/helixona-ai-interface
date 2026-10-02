import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { cellValue, expandFileRefs, markdownToXlsxBlob, parseRef, parseRowList, sheetNames, workbookModel, type FileTables } from "./workbook";
import { applyRule, cellDate, cellNumber, formatLike, parseCondition } from "./tableQuery";

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

const claims: FileTables = {
  name: "CwReport.xlsx",
  sheets: [
    {
      name: "Sheet1",
      truncatedRows: 0,
      rows: [
        ["Patient", "DOS", "Payer", "Status", "Allowed Amount", "Paid Amount"],
        ["Smith, John", "1/15/2026", "Aetna", "Paid", "$250.00", "$200.00"],
        ["Lee, Mia", "2/3/2026", "Cigna", "Denied", "$0.00", "$0.00"],
        ["SMITH, JOHN", "3/9/2026", "Aetna", "Paid", "$1,100.00", "$980.50"],
        ["Lee, Mia", "3/20/2026", "Cigna", "Paid", "$300.00", "$240.00"],
        ["Pérez, Ana", "12/30/2025", "UHC", "Open", "", ""],
      ],
    },
  ],
};
const resolveClaims = async (name: string) => (name.toLowerCase().startsWith("cwreport") ? claims : null);

describe("Rules computed over an attached spreadsheet", () => {
  it("reads cells the way staff do: amounts, negatives, percentages and dates", () => {
    expect([cellNumber("$1,234.50"), cellNumber("($20.00)"), cellNumber("-$5"), cellNumber("12.5%"), cellNumber("abc"), cellNumber("")]).toEqual([1234.5, -20, -5, 12.5, null, null]);
    expect(cellDate("1/15/2026")).toBe(new Date(2026, 0, 15).getTime());
    expect(cellDate("1/15/2026 6:00 PM")).toBe(new Date(2026, 0, 15, 18).getTime());
    expect(cellDate("2026-01-15")).toBe(new Date(2026, 0, 15).getTime());
    expect(cellDate("Jan")).toBeNull();
    expect(formatLike(["$250.00", "$1,100.00"], 1350)).toBe("$1,350.00");
    expect(formatLike(["12.5%", "7.0%"], 9.75)).toBe("9.8%");
    expect(formatLike(["3", "4"], 3.5)).toBe("4");
  });

  it("reads the conditions and options the model writes", () => {
    expect(parseCondition("Status = Paid")).toEqual({ column: "Status", op: "=", value: "Paid" });
    expect(parseCondition("Paid Amount>100")).toEqual({ column: "Paid Amount", op: ">", value: "100" });
    expect(parseCondition("Payer contains aet")).toEqual({ column: "Payer", op: "contains", value: "aet" });
    expect(parseCondition("Notes is not empty")).toEqual({ column: "Notes", op: "is not empty", value: "" });
    expect(parseCondition("Status in (Paid, Open)")).toEqual({ column: "Status", op: "in", value: "Paid, Open" });
    const ref = parseRef("CwReport.xlsx | where: Status = Paid; Paid Amount > 100 | group: Patient | max: Paid Amount, Allowed Amount | sort: Highest Paid Amount desc | top: 10 | columns: Patient, Highest Paid Amount | nonsense");
    expect(ref.rule).toEqual({
      where: [{ column: "Status", op: "=", value: "Paid" }, { column: "Paid Amount", op: ">", value: "100" }],
      group: ["Patient"],
      aggregates: [{ fn: "max", column: "Paid Amount" }, { fn: "max", column: "Allowed Amount" }],
      pick: null,
      sort: { column: "Highest Paid Amount", desc: true },
      columns: ["Patient", "Highest Paid Amount"],
      top: 10,
    });
    expect(ref.unknown).toEqual(["nonsense"]);
    expect(parseRef("x | group by: Patient | pick: highest Paid Amount | count").rule).toMatchObject({ group: ["Patient"], pick: { fn: "highest", column: "Paid Amount" }, aggregates: [{ fn: "count", column: null }] });
  });

  it("filters, groups, totals and picks rows, keeping the file's own text in the result", () => {
    const [header, ...data] = claims.sheets[0]!.rows;
    const perPatient = applyRule(header!, data, parseRef("f | group: Patient | max: Paid Amount, Allowed Amount | count").rule, "f");
    expect(perPatient.problems).toEqual([]);
    expect(perPatient.rows).toEqual([
      ["Patient", "Highest Paid Amount", "Highest Allowed Amount", "Rows"],
      ["Smith, John", "$980.50", "$1,100.00", "2"],
      ["Lee, Mia", "$240.00", "$300.00", "2"],
      ["Pérez, Ana", "", "", "1"],
    ]);
    const picked = applyRule(header!, data, parseRef("f | group: patient | pick: highest paid amount | columns: Patient, DOS, Paid Amount").rule, "f");
    expect(picked.rows).toEqual([
      ["Patient", "DOS", "Paid Amount"],
      ["SMITH, JOHN", "3/9/2026", "$980.50"],
      ["Lee, Mia", "3/20/2026", "$240.00"],
      ["Pérez, Ana", "12/30/2025", ""],
    ]);
    const filtered = applyRule(header!, data, parseRef("f | where: Payer = Aetna; DOS >= 2/1/2026 | sort: Paid Amount desc").rule, "f");
    expect(filtered.rows.map((r) => r[0])).toEqual(["Patient", "SMITH, JOHN"]);
    const totals = applyRule(header!, data, parseRef("f | where: Status in (Paid, Denied) | sum: Paid Amount | avg: Allowed Amount | count").rule, "f");
    expect(totals.rows).toEqual([["Total Paid Amount", "Average Allowed Amount", "Rows"], ["$1,420.50", "$412.50", "4"]]);
    const byPayer = applyRule(header!, data, parseRef("f | group: Payer | sum: Paid Amount | sort: Total Paid Amount desc | top: 2").rule, "f");
    expect(byPayer.rows).toEqual([["Payer", "Total Paid Amount"], ["Aetna", "$1,180.50"], ["Cigna", "$240.00"]]);
    const unknown = applyRule(header!, data, parseRef("f | where: Balance > 0").rule, "f");
    expect(unknown.rows).toEqual([]);
    expect(unknown.problems).toEqual(['"f" has no column named "Balance".']);
  });

  it("puts a computed table in the workbook, from the whole file, and says what it could not do", async () => {
    const md = "# Highest paid per patient\n\n## Per patient\n\n{{file: CwReport.xlsx | group: Patient | max: Paid Amount, Allowed Amount}}\n\n## Aetna claims\n\n{{file: CwReport.xlsx | where: Payer = Aetna | sort: DOS | typo}}\n\n## Bad\n\n{{file: CwReport.xlsx | group: Nobody | count}}";
    const { markdown, problems } = await expandFileRefs(md, resolveClaims);
    const model = workbookModel(markdown, "x");
    expect(model[0]!.tables[0]).toEqual([
      ["Patient", "Highest Paid Amount", "Highest Allowed Amount"],
      ["Smith, John", "$980.50", "$1,100.00"],
      ["Lee, Mia", "$240.00", "$300.00"],
      ["Pérez, Ana", "", ""],
    ]);
    expect(model[1]!.tables[0]!.map((r) => r[1])).toEqual(["DOS", "1/15/2026", "3/9/2026"]);
    expect(problems).toEqual([
      'In a reference to "CwReport.xlsx", this was not understood and was ignored: typo.',
      'The rule for "CwReport.xlsx" (per Nobody, count) could not be applied: "CwReport.xlsx" has no column named "Nobody".',
    ]);
    expect(markdown).toContain("could not be applied");
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
