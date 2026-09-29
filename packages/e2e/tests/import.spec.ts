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
});
