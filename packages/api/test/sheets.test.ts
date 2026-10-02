import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { CircuitBreaker, DEFAULT_CATALOG, FakeProvider, ModelRouter, noopLogger, type LlmProvider, type StreamParams } from "@helixona/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DevIdentityProvider } from "../src/auth/dev.js";
import { SessionService } from "../src/auth/session.js";
import { memoryRepos, MemoryUserDirectory } from "../src/repos/memory.js";
import { MemoryAttachmentStore } from "../src/attachments/store.js";
import { MemoryFeedbackSender } from "../src/feedback.js";
import { columnSummary, fitForModel, parseCsv, parseXlsx, readTables, SpreadsheetError, tablesForModel, XLSX_TYPE } from "../src/attachments/sheets.js";
import { sheetTextKey } from "../src/attachments/documents.js";
import { sheetCharBudget } from "../src/attachments/policy.js";
import type { Deps } from "../src/deps.js";

const H = { "x-requested-with": "helixona", "content-type": "application/json" };

/** A small workbook written by hand, the way Excel stores one. */
async function workbook(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
  zip.file(
    "xl/workbook.xml",
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><sheets>` +
      `<sheet name="Checks &amp; EOBs" sheetId="1" r:id="rId1"/><sheet name="Secret" sheetId="2" state="hidden" r:id="rId2"/><sheet name="May" sheetId="3" r:id="rId3"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="worksheet" Target="/xl/worksheets/sheet3.xml"/></Relationships>`,
  );
  zip.file(
    "xl/sharedStrings.xml",
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Patient</t></si><si><t>Check #</t></si><si><t>Amount</t></si><si><t>Status</t></si>` +
      `<si><r><t>Ana </t></r><r><rPr><b/></rPr><t>Pérez</t></r><rPh><t>ignored</t></rPh></si><si><t>Cashed</t></si><si><t xml:space="preserve">Outstanding </t></si></sst>`,
  );
  zip.file(
    "xl/styles.xml",
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>` +
      `<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="10"/><xf numFmtId="22"/></cellXfs></styleSheet>`,
  );
  const sheet = (rows: string) => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  zip.file(
    "xl/worksheets/sheet1.xml",
    sheet(
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="inlineStr"><is><t>Mailed</t></is></c><c r="F1" t="str"><v>Rate</v></c></row>` +
        `<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2"><v>100234</v></c><c r="C2" s="1"><v>1234.5</v></c><c r="D2" t="s"><v>5</v></c><c r="E2" s="2"><v>46037</v></c><c r="F2" s="3"><v>0.125</v></c></row>` +
        `<row r="3"><c r="A3" t="inlineStr"><is><t>Luis &lt;Jr&gt;</t></is></c><c r="B3" t="str"><v>000981</v></c><c r="C3" s="1"><v>-20</v></c><c r="D3" t="s"><v>6</v></c><c r="E3" s="4"><v>46037.75</v></c><c r="F3"><v>0.30000000000000004</v></c></row>` +
        `<row r="5"><c r="A5" t="b"><v>1</v></c><c r="D5"><v>7</v></c></row>`,
    ),
  );
  zip.file("xl/worksheets/sheet2.xml", sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>hidden</t></is></c></row>`));
  zip.file("xl/worksheets/sheet3.xml", sheet(`<row r="1"><c r="A1" t="inlineStr"><is><t>Only</t></is></c><c r="C1" t="inlineStr"><is><t>gap</t></is></c></row>`));
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

describe("Reading spreadsheets", () => {
  it("reads CSV the way Excel does: quotes, commas and line breaks in cells, CRLF, a byte-order mark, other separators", () => {
    expect(parseCsv('﻿Name,Note\r\n"Pérez, Ana","said ""hi""\nthen left"\r\nLuis,\r\n')).toEqual([
      ["Name", "Note"],
      ["Pérez, Ana", 'said "hi"\nthen left'],
      ["Luis", ""],
    ]);
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("reads the visible sheets of a workbook as Excel shows them: shared and inline text, amounts, dates, percentages, gaps", async () => {
    const sheets = await parseXlsx(await workbook());
    expect(sheets.map((s) => s.name)).toEqual(["Checks & EOBs", "May"]);
    expect(sheets[0]!.rows).toEqual([
      ["Patient", "Check #", "Amount", "Status", "Mailed", "Rate"],
      ["Ana Pérez", "100234", "$1,234.50", "Cashed", "1/15/2026", "12.50%"],
      ["Luis <Jr>", "000981", "-$20.00", "Outstanding ", "1/15/2026 6:00 PM", "0.3"],
      ["", "", "", "", "", ""],
      ["TRUE", "", "", "7", "", ""],
    ]);
    expect(sheets[1]!.rows).toEqual([["Only", "", "gap"]]);
  });

  it("refuses what is not a workbook, and shows the model each row with its Excel row number", async () => {
    await expect(parseXlsx(Buffer.from("PK not really a zip"))).rejects.toBeInstanceOf(SpreadsheetError);
    const noBook = new JSZip();
    noBook.file("hello.txt", "hi");
    await expect(parseXlsx(await noBook.generateAsync({ type: "uint8array" }))).rejects.toThrow(/Excel workbook/);

    const csv = await readTables("text/csv", Buffer.from("Patient,Amount\nAna,$10.00\nLuis,$5.00\n"));
    expect(tablesForModel("Checks.csv", csv)).toBe(`Sheet "Sheet1" of "Checks.csv": 3 rows.\nRow,Patient,Amount\n2,Ana,$10.00\n3,Luis,$5.00`);
  });

  it("cuts a file that is too long for one conversation: each sheet keeps its header and a share of the rows, and says what is left out", () => {
    const claims = { name: "Claims", rows: [["Patient", "Amount"], ...Array.from({ length: 100 }, (_, i) => [`P${i}`, `$${i}.00`])], truncatedRows: 0 };
    const notes = { name: "Notes", rows: [["Note"], ["a"], ["b"]], truncatedRows: 0 };
    const full = fitForModel("Claims.xlsx", [claims, notes]);
    expect([full.rows, full.rowsLeft]).toEqual([104, 0]);
    expect(full.text).not.toContain("not shown");
    const half = fitForModel("Claims.xlsx", [claims, notes], Math.floor(full.text.length / 2));
    // The data fits the budget; the sheet headings (with the note) come on top.
    expect(half.text.length).toBeLessThan(full.text.length / 2 + 2 * 480);
    expect(half.rows + half.rowsLeft).toBe(104);
    expect(half.text).toMatch(/^Sheet "Claims" of "Claims.xlsx": \d+ rows; \d+ more rows are not shown because the file is too long for one conversation \(ask for a file with only the rows and columns needed, or split it\)\. The interface still has every row[^\n]*\nRow,Patient,Amount\n2,P0,\$0\.00\n/);
    expect(half.text).toContain('\n\nSheet "Notes" of "Claims.xlsx": ');
    // The header always goes, even when the sheet's share is smaller than it.
    const tiny = fitForModel("Claims.xlsx", [claims, notes], 10);
    expect(tiny.rows).toBe(2);
    expect(tiny.text).toContain("Row,Patient,Amount\n\n");
    expect(tiny.text).toContain("Row,Note");
    // Rows beyond the row cap are reported too, with their own reason.
    const capped = fitForModel("Big.xlsx", [{ ...notes, truncatedRows: 5000 }]);
    expect(capped.text).toContain("3 rows; 5,000 more rows are not shown because the sheet is too long (ask for");
  });

  it("describes every column of a long sheet over all its rows, so the model knows the file it sees only part of", () => {
    const rows = [["Patient", "DOS", "Status", "Paid Amount", "Note", "Empty"], ...Array.from({ length: 300 }, (_, i) => [`Patient ${i % 120}`, `${1 + (i % 12)}/${1 + (i % 28)}/2026`, i % 3 === 0 ? "Denied" : "Paid", `$${(i * 10.5).toFixed(2)}`, i % 50 === 0 ? "call" : "", ""])];
    const summary = columnSummary(rows);
    expect(summary).toBe(
      "Columns, over all 300 rows: Patient (text, 300 filled, 120 distinct, e.g. Patient 0, Patient 1, Patient 2); DOS (date, 300 filled, from 1/1/2026 to 12/28/2026); Status (text, 300 filled: Paid ×200, Denied ×100); Paid Amount (number, 300 filled, 300 distinct, min $0.00, max $3,139.50, sum $470,925.00); Note (text, 6 filled: call ×6); Empty (empty).",
    );
    const fitted = fitForModel("Claims.xlsx", [{ name: "Claims", rows, truncatedRows: 0 }], 6_000);
    expect(fitted.text).toMatch(/^Sheet "Claims" of "Claims.xlsx": \d+ rows; \d+ more rows are not shown because the file is too long for one conversation \(ask for a file with only the rows and columns needed, or split it\)\. The interface still has every row: a \{\{file: …\}\} reference with where, group, max, min, sum, avg, count, sort or top is computed over the whole file, so use references for lists, totals and per-patient figures instead of reading rows\.\nColumns, over all 300 rows: /);
    expect(fitted.text.length).toBeLessThan(6_000 + 500);
    expect(fitted.text).toContain("\nRow,Patient,DOS,Status,Paid Amount,Note,Empty\n2,Patient 0,1/1/2026,Denied,$0.00,call,\n");
    // A short sheet has no summary.
    expect(fitForModel("Small.xlsx", [{ name: "S", rows: rows.slice(0, 50), truncatedRows: 0 }]).text).not.toContain("Columns, over all");
  });
});

async function makeApp(wrap?: (p: LlmProvider) => LlmProvider) {
  const config = loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", STORE_MODE: "memory", LLM_MODE: "fake", SESSION_SECRET: "test-secret-test-secret", DAILY_QUOTA_USD: "100", WEB_DIST: "/nonexistent", TRAINING_REQUIRED: "false" });
  const repos = memoryRepos();
  const fake = new FakeProvider({ refusalFallbacks: Object.fromEntries(DEFAULT_CATALOG.models.map((m) => [m.modelId, m.refusalFallbacks])), delayMs: 0 });
  const provider = wrap ? wrap(fake) : fake;
  const deps: Deps = {
    config, log: noopLogger, catalog: DEFAULT_CATALOG, repos,
    sessions: new SessionService({ repo: repos.sessions, secret: config.SESSION_SECRET!, idleSeconds: config.SESSION_IDLE_SECONDS, absoluteSeconds: config.SESSION_ABSOLUTE_SECONDS }),
    identity: new DevIdentityProvider(), directory: new MemoryUserDirectory(), provider,
    router: new ModelRouter({ catalog: DEFAULT_CATALOG, provider, breaker: new CircuitBreaker(), firstEventTimeoutMs: 2000 }),
    systemPrompt: { text: "test system prompt", version: "v1" },
    attachments: new MemoryAttachmentStore(),
    passwordAuth: null,
    feedback: new MemoryFeedbackSender(),
  };
  return { app: await buildApp(deps), repos, store: deps.attachments as MemoryAttachmentStore };
}

async function login(app: FastifyInstance, username = "ana"): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", headers: H, payload: { username, role: "staff" } });
  return `hx_session=${r.cookies.find((c) => c.name === "hx_session")!.value}`;
}

async function upload(app: FastifyInstance, cookie: string, convId: string, name: string, bytes: Buffer, contentType: string) {
  const created = await app.inject({ method: "POST", url: `/api/conversations/${convId}/attachments`, headers: { ...H, cookie }, payload: { name, size: bytes.length, contentType } });
  expect(created.statusCode).toBe(201);
  const a = created.json();
  expect((await app.inject({ method: "PUT", url: a.upload.url, headers: { "content-type": contentType, "x-requested-with": "helixona" }, payload: bytes })).statusCode).toBe(200);
  return { id: a.id as string, name: a.name as string };
}

describe("Spreadsheets in a conversation", () => {
  it("an Excel file is read on the server, the model sees numbered rows, and the browser can fetch the original rows", async () => {
    let calls: StreamParams[] = [];
    const { app, repos } = await makeApp((inner) => ({ stream: (p, o) => (calls.push(p), inner.stream(p, o)) }));
    const cookie = await login(app);
    const conv = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "opus" } })).json();
    const xlsx = await upload(app, cookie, conv.id, "Checks May.xlsx", await workbook(), XLSX_TYPE);
    const r = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "/sheet Split the checks", attachments: [xlsx] } });
    expect(r.statusCode).toBe(200);
    const answer = [...r.body.matchAll(/^event: text_delta\ndata: (.+)$/gm)].map((m) => (JSON.parse(m[1]!) as { text: string }).text).join("");
    expect(answer).toContain("```document-xlsx");
    expect(answer).toContain("{{file: Checks May.xlsx | rows: 2, 4}}");

    const doc = (calls.at(-1)!.messages.at(-1)!.content as Array<{ type: string; title?: string; context?: string; source?: { data: string } }>)[0]!;
    expect(doc.title).toBe("Checks May.xlsx");
    expect(doc.context).toContain("Row, is the Excel row number");
    expect(doc.source!.data).toContain(`Sheet "Checks & EOBs" of "Checks May.xlsx": 5 rows.\nRow,Patient,Check #,Amount,Status,Mailed,Rate\n2,Ana Pérez,100234,"$1,234.50",Cashed,1/15/2026,12.50%`);
    expect(doc.source!.data).not.toContain("hidden");

    const table = await app.inject({ method: "GET", url: `/api/conversations/${conv.id}/attachments/${xlsx.id}/table`, headers: { cookie } });
    expect(table.statusCode).toBe(200);
    expect(table.json()).toMatchObject({ id: xlsx.id, name: "Checks May.xlsx", sheets: [{ name: "Checks & EOBs", truncatedRows: 0 }, { name: "May" }] });
    expect(table.json().sheets[0].rows[2]).toEqual(["Luis <Jr>", "000981", "-$20.00", "Outstanding ", "1/15/2026 6:00 PM", "0.3"]);
    const opened = repos.audit.events.filter((e) => e.action === "attachment_opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]!.meta).toEqual({ attachmentId: xlsx.id, sheets: 2, rows: 6 });
    expect(JSON.stringify(opened)).not.toContain("Pérez");

    // Only people who can see the conversation, and only its own spreadsheets.
    const other = await login(app, "bruno");
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conv.id}/attachments/${xlsx.id}/table`, headers: { cookie: other } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conv.id}/attachments/01ARZ3NDEKTSV4RRFFQ69G5FAV/table`, headers: { cookie } })).statusCode).toBe(404);
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const letter = await upload(app, cookie, conv.id, "Letter.pdf", Buffer.from(await pdf.save()), "application/pdf");
    await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "And this", attachments: [letter] } });
    const notSheet = await app.inject({ method: "GET", url: `/api/conversations/${conv.id}/attachments/${letter.id}/table`, headers: { cookie } });
    expect(notSheet.statusCode).toBe(400);
    expect(notSheet.json().error.code).toBe("not_a_spreadsheet");
  });

  it("a file too long for one conversation is cut to fit, read once, and the model is told what is missing", async () => {
    const calls: StreamParams[] = [];
    const { app, repos, store } = await makeApp((inner) => ({ stream: (p, o) => (calls.push(p), inner.stream(p, o)) }));
    const cookie = await login(app);
    const conv = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "sonnet" } })).json();
    // 12,000 rows of about 40 characters: 480k characters, over the 315k the test context window allows a file.
    const csv = "Patient,Account,Amount,Status\n" + Array.from({ length: 12_000 }, (_, i) => `Patient ${i},ACC${100000 + i},$${i}.00,Open`).join("\n") + "\n";
    const report = await upload(app, cookie, conv.id, "Report.csv", Buffer.from(csv), "text/csv");
    const r = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "How many are open?", attachments: [report] } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain("event: done");
    expect(r.body).not.toContain("context_limit");
    const doc = (calls.at(-1)!.messages.at(-1)!.content as Array<{ type: string; context?: string; source?: { data: string } }>)[0]!;
    expect(doc.context).toContain("computes {{file: …}} references over all of them");
    const text = doc.source!.data;
    // The rows fit the budget; the sheet heading and the column summary come on top.
    expect(text.length).toBeLessThanOrEqual(Math.min(300_000, sheetCharBudget(150_000)) + 1_000);
    expect(text).toMatch(/^Sheet "Sheet1" of "Report.csv": [\d,]+ rows; [\d,]+ more rows are not shown because the file is too long for one conversation/);
    expect(text).toContain("The interface still has every row");
    expect(text).toContain("\nColumns, over all 12,000 rows: Patient (text, 12,000 filled, 12,000 distinct, e.g. Patient 0, Patient 1, Patient 2); Account (text, 12,000 filled, 12,000 distinct, e.g. ACC100000, ACC100001, ACC100002); Amount (number, 12,000 filled, 12,000 distinct, min $0.00, max $11,999.00, sum $71,994,000.00); Status (text, 12,000 filled: Open ×12,000).\n");
    expect(text).toContain("\nRow,Patient,Account,Amount,Status\n2,Patient 0,ACC100000,$0.00,Open\n");
    // The size the model sees is kept with the file, and the rows are read once and kept next to it.
    const stored = (await repos.messages.list(conv.id))[0]!.attachments![0]!;
    expect(stored.modelChars).toBe(text.length);
    expect(await store.head(sheetTextKey(stored))).toMatchObject({ contentType: "text/plain", size: Buffer.byteLength(text) });
    const reads: string[] = [];
    const get = store.get.bind(store);
    store.get = async (key) => (reads.push(key), get(key));
    await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "And closed?" } });
    expect(reads).toEqual([sheetTextKey(stored)]);
    // The browser still gets every row of the original file.
    const table = await app.inject({ method: "GET", url: `/api/conversations/${conv.id}/attachments/${report.id}/table`, headers: { cookie } });
    expect(table.json().sheets[0].rows).toHaveLength(12_001);
  });

  it("a file named .xlsx that is not a workbook is refused before the answer, with a message staff can act on", async () => {
    const { app } = await makeApp();
    const cookie = await login(app);
    const conv = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "opus" } })).json();
    const bad = await upload(app, cookie, conv.id, "Old report.xlsx", Buffer.from("this was an .xls renamed"), XLSX_TYPE);
    const r = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "Split it", attachments: [bad] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("not_a_spreadsheet");
    expect(r.json().error.message).toMatch(/Old report\.xlsx.*Save it again as \.xlsx or CSV/);
    // CSV rows reach the model numbered too.
    let calls: StreamParams[] = [];
    const second = await makeApp((inner) => ({ stream: (p, o) => (calls.push(p), inner.stream(p, o)) }));
    const c2 = await login(second.app);
    const conv2 = (await second.app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie: c2 }, payload: { modelAlias: "opus" } })).json();
    const csv = await upload(second.app, c2, conv2.id, "Checks.csv", Buffer.from("Patient,Status\nAna,Cashed\n"), "text/csv");
    await second.app.inject({ method: "POST", url: `/api/conversations/${conv2.id}/messages`, headers: { ...H, cookie: c2 }, payload: { text: "Which were cashed?", attachments: [csv] } });
    const doc = (calls.at(-1)!.messages.at(-1)!.content as Array<{ source?: { data: string } }>)[0]!;
    expect(doc.source!.data).toBe(`Sheet "Sheet1" of "Checks.csv": 2 rows.\nRow,Patient,Status\n2,Ana,Cashed`);
  });
});
