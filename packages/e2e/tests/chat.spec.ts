import fs from "node:fs";
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
    await expect(page.locator(".msg-assistant").nth(2).locator(".badge-model")).toHaveText("Sonnet 5");
    await expect(page.locator(".msg-assistant").nth(2)).toContainText("claude-sonnet-5");
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
});
