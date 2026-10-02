import fs from "node:fs";
import JSZip from "jszip";
import { expect, test } from "@playwright/test";
import { devLogin, samplePdf, skipTraining, uniqueUser, watchErrors } from "./helpers";

test.describe("Conversations", () => {
  test.beforeEach(async ({ context }) => {
    await devLogin(context, uniqueUser("e2e-chat"), "staff");
    await skipTraining(context);
  });

  test("a conversation from the start screen: streamed reply, more turns, model change, rename, reload, delete", async ({ page, context }) => {
    const errs = watchErrors(page);
    await page.goto("/", { waitUntil: "load" });
    await expect(page.locator(".home-start h1")).toContainText("Hello");
    await page.getByPlaceholder("Write a message…").fill("Summarize the HIPAA safeguards");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-user")).toHaveCount(1);
    await expect(page.locator(".msg-assistant")).toHaveCount(1);
    await expect(page.locator(".msg-assistant").first()).toContainText("Simulated reply");
    await expect(page.locator(".msg-assistant").first()).toContainText("Received: \"Summarize the HIPAA safeguards\"");
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    // Markdown: a list and a link marked as external.
    await expect(page.locator(".msg-assistant li").first()).toBeVisible();
    await expect(page.locator(".msg-assistant").first().getByText("Open external link")).toBeVisible();

    // The reply leaves the app with its formatting: on the clipboard (for Word, eClinicalWorks, email) or as a Word file.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const reply = page.locator(".msg-assistant").first();
    await reply.getByRole("button", { name: "Copy the response (formatted)" }).click();
    await expect(reply.getByRole("button", { name: "Copy the response (formatted)" })).toHaveText("Copied");
    const clip = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const read = async (type: string) => (item!.types.includes(type) ? await (await item!.getType(type)).text() : "");
      return { html: await read("text/html"), text: await read("text/plain") };
    });
    expect(clip.html).toContain("<li>");
    expect(clip.text).toContain("Simulated reply");
    expect(clip.text).not.toContain("**");
    const [download] = await Promise.all([page.waitForEvent("download"), reply.getByRole("button", { name: "Download the response as a Word document" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^Conversation .*\.docx$/);
    expect(fs.readFileSync((await download.path())!).subarray(0, 2).toString()).toBe("PK");

    // Enter sends; Shift+Enter makes a new line.
    const box = page.locator("#composer-text");
    await box.fill("Line one");
    await box.press("Shift+Enter");
    await box.type("Line two");
    await expect(box).toHaveValue("Line one\nLine two");
    await box.press("Enter");
    await expect(page.locator(".msg-user")).toHaveCount(2);
    await expect(page.locator(".msg-user").nth(1).locator(".user-text")).toHaveText("Line one\nLine two");
    await expect(page.locator(".msg-assistant")).toHaveCount(2);
    await expect(page.locator(".composer-stop")).toHaveCount(0);

    // Changing the model applies to the next reply.
    await page.locator("#chat-model").selectOption("sonnet");
    await box.fill("Third question");
    await box.press("Enter");
    await expect(page.locator(".msg-assistant")).toHaveCount(3);
    await expect(page.locator(".msg-assistant").nth(2).locator(".badge-model")).toHaveText("Sonnet 5.5");
    await expect(page.locator(".msg-assistant").nth(2)).toContainText("claude-sonnet-5-5");
    await expect(page.locator(".composer-stop")).toHaveCount(0);

    // The sidebar row: rename, then the title everywhere.
    const row = page.locator(".conv-list .conv-row").first();
    await expect(page.locator(".conv-list .conv-row")).toHaveCount(1);
    await row.hover();
    await row.getByRole("button", { name: /^Rename:/ }).click();
    await page.locator(".rename-form input").fill("Renamed chat");
    await page.locator(".rename-form").getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".conv-list .conv-title").first()).toHaveText("Renamed chat");
    await expect(page.locator(".chat-title")).toHaveText("Renamed chat");

    // Everything survives a reload, and the URL brings the same conversation back.
    await expect(page).toHaveURL(/\/c\/[0-9A-Z]{26}$/);
    await page.reload({ waitUntil: "load" });
    await expect(page.locator(".msg")).toHaveCount(6);
    await expect(page.locator(".chat-title")).toHaveText("Renamed chat");

    // Delete asks first, then the start screen is back.
    page.once("dialog", (d) => void d.accept());
    await page.locator(".conv-list .conv-row").first().hover();
    await page.locator(".conv-list .conv-row").first().getByRole("button", { name: /^Delete:/ }).click();
    await expect(page.locator(".conv-list .conv-row")).toHaveCount(0);
    await expect(page.locator(".home-start")).toBeVisible();
    errs.expectNone();
  });

  test("a request for a document is answered with a file card: Word by default, the other formats a click away", async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto("/", { waitUntil: "load" });
    await page.getByPlaceholder("Write a message…").fill("/doc Intake summary");
    await page.getByRole("button", { name: "Send" }).click();
    const card = page.locator(".doc-card").first();
    await expect(card).toBeVisible();
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    await expect(card.locator(".doc-title")).toHaveText("Intake summary");
    await expect(card.locator(".doc-kind")).toHaveText("Document · DOCX");
    // The remarks around the document stay as text; the response has no second row of buttons.
    await expect(page.locator(".msg-assistant").first()).toContainText("Review the names and dates before sending.");
    await expect(page.locator(".msg-assistant .msg-actions")).toHaveCount(0);
    const [docx] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Download Intake summary as Word" }).click()]);
    expect(docx.suggestedFilename()).toBe("Intake summary.docx");
    expect(fs.readFileSync((await docx.path())!).subarray(0, 2).toString()).toBe("PK");
    const [txt] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Download Intake summary as Text" }).click()]);
    expect(txt.suggestedFilename()).toBe("Intake summary.txt");
    expect(fs.readFileSync((await txt.path())!, "utf8")).toContain("• First finding");
    const [csv] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Download Intake summary as CSV" }).click()]);
    expect(csv.suggestedFilename()).toBe("Intake summary.csv");
    expect(fs.readFileSync((await csv.path())!, "utf8")).toContain("Item,Value\nSample,12.3");
    // Clicking the card opens the preview beside the chat: white pages with the letterhead and a page counter.
    await card.getByRole("button", { name: "Open Intake summary" }).click();
    const viewer = page.locator(".doc-viewer");
    await expect(viewer).toBeVisible();
    await expect(viewer.locator(".doc-viewer-title")).toContainText("Intake summary");
    await expect(viewer.locator(".doc-viewer-title")).toContainText("DOCX");
    const sheet = viewer.locator(".doc-page").first();
    await expect(sheet.locator(".print-doc-brand")).toHaveText("HELIXONA");
    await expect(sheet.locator("h1")).toHaveText("Intake summary");
    await expect(sheet.locator("table")).toBeVisible();
    await expect(viewer.locator(".doc-page-pill")).toHaveText("Page 1 / 1");
    await viewer.getByRole("button", { name: "Expand the preview" }).click();
    await expect(page.locator(".split.viewer-wide")).toHaveCount(1);
    await viewer.getByRole("button", { name: "Shrink the preview" }).click();
    await expect(page.locator(".split.viewer-wide")).toHaveCount(0);
    const [fromViewer] = await Promise.all([page.waitForEvent("download"), viewer.getByRole("button", { name: "Download Intake summary" }).click()]);
    expect(fromViewer.suggestedFilename()).toBe("Intake summary.docx");
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);

    // PDF goes through the browser's print dialog, with the page named after the document.
    await page.evaluate(() => {
      const w = window as unknown as { __printed?: string | null };
      w.__printed = null;
      window.print = () => {
        w.__printed = document.title;
        // A real browser fires this once the print dialog closes.
        window.dispatchEvent(new Event("afterprint"));
      };
    });
    await page.locator("#composer-text").fill("/doc-pdf Referral letter");
    await page.keyboard.press("Enter");
    const second = page.locator(".doc-card").nth(1);
    await expect(second.locator(".doc-kind")).toHaveText("Document · PDF");
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    await second.getByRole("button", { name: "Download Referral letter as PDF" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __printed?: string | null }).__printed)).toBe("Referral letter");
    // Afterwards the page is itself again.
    await expect.poll(() => page.evaluate(() => document.body.classList.contains("printing-doc"))).toBe(false);
    errs.expectNone();
  });

  test("Stop interrupts a streaming reply and says so", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByPlaceholder("Write a message…").fill("A long answer please");
    await page.getByRole("button", { name: "Send" }).click();
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    await expect(page.locator(".msg-assistant").first().locator(".notice")).toContainText("Stopped by you");
    // What was sent and answered so far is kept: a reload shows the same turn, still marked as stopped.
    await page.reload({ waitUntil: "load" });
    await expect(page.locator(".msg-user")).toHaveCount(1);
    await expect(page.locator(".msg-assistant").first().locator(".notice")).toContainText("Stopped by you");
    // The conversation goes on afterwards.
    await page.locator("#composer-text").fill("Continue");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg-assistant")).toHaveCount(2);
    await expect(page.locator(".msg-assistant").nth(1)).toContainText("Simulated reply");
  });

  test("the counter appears near the limit and an over-long message cannot be sent", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await page.getByPlaceholder("Write a message…").fill("Start");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-assistant")).toHaveCount(1);
    const box = page.locator("#composer-text");
    const counter = page.locator("#composer-counter");
    await box.fill("x".repeat(100));
    await expect(counter).toBeHidden();
    await box.fill("x".repeat(16_500));
    await expect(counter).toBeVisible();
    await expect(counter).toContainText("16,500 / 20,000");
    await box.fill("x".repeat(20_001));
    await expect(counter).toHaveClass(/over/);
    await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  test("a file picked on the start screen travels with the first message", async ({ page }) => {
    await page.goto("/", { waitUntil: "load" });
    await page.locator(".composer-start input[type=file]").setInputFiles({ name: "Referral.pdf", mimeType: "application/pdf", buffer: await samplePdf("Referral") });
    await expect(page.locator(".composer-start .attach-chip")).toContainText("Referral.pdf");
    await page.getByPlaceholder("Write a message…").fill("What is this about?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-user .attach-chip")).toContainText("Referral.pdf");
    await expect(page.locator(".msg-assistant")).toHaveCount(1);
    await expect(page).toHaveURL(/\/c\/[0-9A-Z]{26}$/);
  });

  test("a PDF attached from the composer travels with the message; unsupported files are refused", async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto("/", { waitUntil: "load" });
    await page.getByPlaceholder("Write a message…").fill("Start");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-assistant")).toHaveCount(1);
    await expect(page.locator(".composer-stop")).toHaveCount(0);

    const input = page.locator(".composer input[type=file]");
    await input.setInputFiles({ name: "virus.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await expect(page.locator(".composer-pending .attach-chip.error")).toContainText("Unsupported type");
    await page.getByRole("button", { name: "Remove virus.exe" }).click();
    await expect(page.locator(".composer-pending .attach-chip")).toHaveCount(0);

    await input.setInputFiles({ name: "EOB March.pdf", mimeType: "application/pdf", buffer: await samplePdf("Explanation of benefits", 2) });
    await expect(page.locator(".composer-pending .attach-chip")).toHaveCount(1);
    await expect(page.locator(".composer-pending .attach-progress")).toHaveCount(0);
    await page.locator("#composer-text").fill("Summarize this document");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg-user").nth(1).locator(".attach-chip")).toContainText("EOB March.pdf");
    await expect(page.locator(".msg-assistant")).toHaveCount(2);
    await expect(page.locator(".composer-pending .attach-chip")).toHaveCount(0);
    errs.expectNone();
  });

  test("check follow-up: an Excel workbook with the original rows and one tab per list, copied from the attached file", async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto("/", { waitUntil: "load" });
    await page.getByPlaceholder("Write a message…").fill("Start");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-assistant")).toHaveCount(1);
    await expect(page.locator(".composer-stop")).toHaveCount(0);

    const input = page.locator(".composer input[type=file]");
    expect(await input.getAttribute("accept")).toContain(".xlsx");
    const csv = 'Patient,Check #,Amount,Status\nAna Pérez,000981,"$1,234.50",Cashed\nLuis Romero,100234,$20.00,Outstanding\nMia Lee,100235,$15.00,Cashed\n';
    await input.setInputFiles({ name: "Checks.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await expect(page.locator(".composer-pending .attach-progress")).toHaveCount(0);
    await page.locator("#composer-text").fill("/sheet The whole spreadsheet, plus a tab for cashed checks and one for checks never cashed");
    await page.keyboard.press("Enter");

    const card = page.locator(".msg-assistant").nth(1).locator(".doc-card");
    await expect(card.locator(".doc-kind")).toHaveText("Spreadsheet · XLSX");
    await expect(card.locator(".doc-title")).toHaveText("Check follow-up");
    const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: "Download Check follow-up as Excel" }).click()]);
    expect(download.suggestedFilename()).toBe("Check follow-up.xlsx");
    const zip = await JSZip.loadAsync(fs.readFileSync((await download.path())!));
    const book = await zip.file("xl/workbook.xml")!.async("string");
    expect([...book.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1])).toEqual(["Original data", "Cashed by patient", "Never cashed", "Largest check per status", "Summary"]);
    const sheet = (n: number) => zip.file(`xl/worksheets/sheet${n}.xml`)!.async("string");
    const all = await sheet(1);
    // The original rows, exactly: the check number keeps its zeros, the amount is a number formatted as money.
    expect(all).toContain("Prepared from Checks.csv.");
    expect(all).toContain(">Ana Pérez<");
    expect(all).toContain(">000981<");
    expect(all).toContain("<v>1234.5</v>");
    expect(all).toContain(">Luis Romero<");
    const cashed = await sheet(2);
    expect(cashed).toContain(">Ana Pérez<");
    expect(cashed).toContain(">Mia Lee<");
    expect(cashed).not.toContain("Luis Romero");
    const never = await sheet(3);
    expect(never).toContain(">Luis Romero<");
    expect(never).not.toContain("Mia Lee");
    // A rule computed in the browser over the whole file: the largest check per status, with the chosen columns.
    const largest = await sheet(4);
    expect(largest).toContain(">Status<");
    expect(largest).toContain(">Ana Pérez<");
    expect(largest).toContain("<v>1234.5</v>");
    expect(largest).toContain(">Luis Romero<");
    expect(largest).not.toContain("Mia Lee");
    expect(largest).not.toContain("Check #");

    // The preview shows the same rows.
    await card.getByRole("button", { name: "Open Check follow-up" }).click();
    const viewer = page.locator(".doc-viewer");
    await expect(viewer.locator(".doc-viewer-title")).toContainText("XLSX");
    await expect(viewer.locator(".doc-page table").first()).toContainText("Luis Romero");
    errs.expectNone();
  });

  test("chart prep: 20 files in one message, and a long PDF is read page by page before the answer", async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto("/", { waitUntil: "load" });
    await page.getByPlaceholder("Write a message…").fill("Start");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-assistant")).toHaveCount(1);
    await expect(page.locator(".composer-stop")).toHaveCount(0);

    // A 101-page history of labs is too long to send whole; the six short panels and the notes are sent as they are.
    const pdfs = [{ name: "Labs 2019-2025.pdf", mimeType: "application/pdf", buffer: await samplePdf("Historical labs", 101) }];
    for (let i = 1; i <= 6; i++) pdfs.push({ name: `Lab panel ${i}.pdf`, mimeType: "application/pdf", buffer: await samplePdf(`Lab panel ${i}`, 2) });
    const input = page.locator(".composer input[type=file]");
    await input.setInputFiles(pdfs);
    await expect(page.locator(".composer-pending .attach-chip")).toHaveCount(7);
    const notes = Array.from({ length: 14 }, (_, i) => ({ name: `Note ${i + 1}.txt`, mimeType: "text/plain", buffer: Buffer.from(`Visit note ${i + 1}: follow-up in 3 months.`) }));
    await input.setInputFiles(notes);
    await expect(page.locator(".composer-pending .attach-chip")).toHaveCount(20);
    await expect(page.locator(".composer .notice")).toHaveText("Up to 20 files per message: 1 file was not added.");
    await expect(page.locator(".composer-pending .attach-progress")).toHaveCount(0);
    await expect(page.locator(".composer-pending .attach-chip.error")).toHaveCount(0);

    await page.locator("#composer-text").fill("Summarize the historical labs");
    await page.keyboard.press("Enter");
    const answer = page.locator(".msg-assistant").nth(1);
    await expect(answer.locator(".files-read")).toHaveText("Read 1 large file page by page · 101 pages", { timeout: 30_000 });
    await expect(answer).toContainText("Simulated reply");
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    // Twenty chips would fill a phone screen: the message shows four and a button for the rest.
    const sent = page.locator(".msg-user").nth(1);
    await expect(sent.locator(".attach-chip")).toHaveCount(4);
    await sent.getByRole("button", { name: "+16 more files" }).click();
    await expect(sent.locator(".attach-chip")).toHaveCount(20);
    await expect(sent.getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");

    // The files stay with the message; the next question reuses the reading instead of reading again.
    await page.locator("#composer-text").fill("Which values were out of range?");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg-assistant")).toHaveCount(3);
    await expect(page.locator(".msg-assistant").nth(2)).toContainText("Which values were out of range?");
    await expect(page.locator(".msg-assistant").nth(2).locator(".files-read, .files-progress")).toHaveCount(0);
    await page.reload({ waitUntil: "load" });
    await expect(page.locator(".msg-user").nth(1).getByRole("button", { name: "+16 more files" })).toBeVisible();
    await expect(page.locator(".msg-user").nth(1).locator(".attach-chip").first()).toContainText("Labs 2019-2025.pdf");
    errs.expectNone();
  });
});
