import { expect, test } from "@playwright/test";
import JSZip from "jszip";
import { devLogin, skipTraining, uniqueUser, watchErrors } from "./helpers";

test.describe("Import from Claude", () => {
  test.beforeEach(async ({ context }) => {
    await devLogin(context, uniqueUser("e2e-import"), "staff");
    await skipTraining(context);
  });

  test("the export zip is read in the browser, imported once, and the chats can be continued", async ({ page }) => {
    const errs = watchErrors(page);
    const zip = new JSZip();
    zip.file(
      "conversations.json",
      JSON.stringify([
        { uuid: "c-1", name: "Lab summary", created_at: "2026-03-01T10:00:00Z", updated_at: "2026-03-01T10:30:00Z", project_uuid: "p-1", chat_messages: [{ sender: "human", text: "Summarize these labs", created_at: "2026-03-01T10:00:00Z", attachments: [{ file_name: "labs.pdf", extracted_content: "Hemoglobin 13.1" }] }, { sender: "assistant", text: "Hemoglobin is normal.", created_at: "2026-03-01T10:01:00Z" }] },
        { uuid: "c-2", name: "Reminder letter", created_at: "2026-04-02T09:00:00Z", chat_messages: [{ sender: "human", text: "Write a reminder letter" }, { sender: "assistant", text: "Dear patient…" }] },
      ]),
    );
    zip.file("projects.json", JSON.stringify([{ uuid: "p-1", name: "Chart prep", description: "Prep", prompt_template: "Be brief.", docs: [{ filename: "Ranges.md", content: "# Ranges" }] }]));
    zip.file("users.json", "[]");
    const buffer = Buffer.from(await zip.generateAsync({ type: "uint8array" }));

    await page.goto("/", { waitUntil: "load" });
    await page.getByRole("link", { name: "Import from Claude" }).click();
    await expect(page).toHaveURL(/\/import$/);
    await expect(page.getByRole("heading", { name: "Import from Claude" })).toBeVisible();
    await page.locator(".import-drop input[type=file]").setInputFiles({ name: "data-2026-03-01.zip", mimeType: "application/zip", buffer });
    const summary = page.locator(".import-summary");
    await expect(summary).toContainText("2 chats with 4 messages, from Mar 1, 2026 to Apr 2, 2026");
    await expect(summary).toContainText("1 projects with 1 documents");
    await expect(summary).toContainText("not in the export");
    await expect(summary).toContainText("Not used: data-2026-03-01.zip › users.json.");
    await page.locator("#import-memory").fill("Works at Helixona. Prefers tables.");
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.locator(".import-done")).toContainText("Done. 2 chats imported; 1 projects with 1 documents; memory saved as the project's instructions.");

    await page.getByRole("link", { name: "Back to the assistant" }).click();
    await expect(page.getByRole("navigation", { name: "Projects", exact: true })).toContainText("Chart prep");
    await expect(page.getByRole("navigation", { name: "Projects", exact: true })).toContainText("Imported from Claude");
    await page.getByRole("button", { name: "Lab summary" }).first().click();
    await expect(page.locator(".msg-user").first()).toContainText("Summarize these labs");
    await expect(page.locator(".msg-assistant").first()).toContainText("Hemoglobin is normal.");
    await page.locator("#composer-text").fill("And the iron?");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg-assistant")).toHaveCount(2);
    await expect(page.locator(".msg-assistant").nth(1)).toContainText("Received: \"And the iron?\"");

    // Importing the same export again duplicates nothing.
    await page.getByRole("link", { name: "Import from Claude" }).click();
    await page.locator(".import-drop input[type=file]").setInputFiles({ name: "data-2026-03-01.zip", mimeType: "application/zip", buffer });
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.locator(".import-done")).toContainText("0 chats imported, 2 already here (skipped); 0 projects with 0 documents (1 already here)");
    errs.expectNone();
  });

  test("a team backup lands in a shared project the whole team sees, kept beyond the retention period", async ({ page, browser }) => {
    const errs = watchErrors(page);
    // A colleague with an account before the import.
    const other = await browser.newContext();
    await devLogin(other, uniqueUser("e2e-import-b"), "staff");
    await skipTraining(other);
    const zip = new JSZip();
    zip.file("conversations.json", JSON.stringify([{ uuid: "c-2", name: "Reminder letter", created_at: "2026-04-02T09:00:00Z", chat_messages: [{ sender: "human", text: "Write a reminder letter" }, { sender: "assistant", text: "Dear patient…" }] }]));
    zip.file("projects.json", JSON.stringify([{ uuid: "p-1", name: "Chart prep", description: "Prep", prompt_template: "Be brief.", docs: [{ filename: "Ranges.md", content: "# Ranges" }] }]));
    const buffer = Buffer.from(await zip.generateAsync({ type: "uint8array" }));

    await page.goto("/", { waitUntil: "load" });
    await page.getByRole("link", { name: "Import from Claude" }).click();
    await page.locator(".import-drop input[type=file]").setInputFiles({ name: "data-2026-04-02.zip", mimeType: "application/zip", buffer });
    await expect(page.locator(".import-summary")).toContainText("1 chats with 2 messages");
    const keep = page.getByRole("checkbox", { name: /Keep the imported chats as a backup/ });
    await expect(keep).not.toBeChecked();
    await page.getByRole("radio", { name: /The whole team/ }).check();
    await expect(keep).toBeChecked();
    await page.locator("#import-memory").fill("Clinic in Miami.");
    await page.getByRole("button", { name: "Import" }).click();
    await expect(page.locator(".import-done")).toContainText("Done. 1 chats imported; 1 projects with 1 documents (in one file of the project); memory saved as the project's instructions.");
    await expect(page.locator(".import-done")).toContainText('Everything is in the shared project "Backup Claude"');
    await expect(page.locator(".import-done")).toContainText("kept as a backup beyond the retention period");

    // The colleague sees the project and the chat, marked as kept, and can continue it.
    const theirs = await other.newPage();
    await theirs.goto("/", { waitUntil: "load" });
    await expect(theirs.getByRole("navigation", { name: "Shared projects" })).toContainText("Backup Claude");
    await theirs.getByRole("button", { name: "Reminder letter" }).first().click();
    await expect(theirs.locator(".msg-user").first()).toContainText("Write a reminder letter");
    await expect(theirs.locator(".msg-assistant").first()).toContainText("Dear patient…");
    await expect(theirs.locator(".chat-head")).toContainText("Backup · kept");
    await theirs.locator("#composer-text").fill("Shorter, please");
    await theirs.keyboard.press("Enter");
    await expect(theirs.locator(".msg-assistant")).toHaveCount(2);
    await other.close();
    errs.expectNone();
  });
});
