import { expect, test } from "@playwright/test";
import { devLogin, samplePdf, skipTraining, uniqueUser, watchErrors } from "./helpers";

test.describe("Projects", () => {
  test("create a project, give it instructions and a file, chat inside it, then delete it", async ({ page, context }) => {
    const errs = watchErrors(page);
    await devLogin(context, uniqueUser("e2e-proj"), "staff");
    await skipTraining(context);
    await page.goto("/", { waitUntil: "load" });

    await page.getByRole("button", { name: "New project" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "New project" })).toBeVisible();
    // The title is edited in place: click it, type, Enter.
    await page.getByRole("heading", { level: 1, name: "New project" }).click();
    await page.locator("#proj-title").fill("EOB review");
    await page.locator("#proj-title").press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "EOB review" })).toBeVisible();
    await expect(page.locator(".project-list .project-select")).toContainText("EOB review");
    await expect(page.locator("#proj-name")).toHaveValue("EOB review");
    const settings = page.locator("form:has(#proj-name)");
    await page.locator("#proj-description").fill("Denied claims and appeals");
    await settings.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.locator(".project-desc")).toHaveText("Denied claims and appeals");

    // Instructions
    await page.locator("section:has(#proj-instructions-h)").getByRole("button", { name: "Add" }).click();
    await page.locator("#proj-instructions").fill("Always cite the plan document.");
    await page.locator("form:has(#proj-instructions)").getByRole("button", { name: "Save" }).click();
    await expect(page.locator("section:has(#proj-instructions-h)")).toContainText("Always cite the plan document.");
    await expect(page.locator("section:has(#proj-instructions-h)").getByRole("button", { name: "Edit" })).toBeVisible();

    // Knowledge
    await page.locator("section:has(#proj-knowledge-h) input[type=file]").setInputFiles({ name: "Plan summary.pdf", mimeType: "application/pdf", buffer: await samplePdf("Plan summary") });
    await expect(page.locator("section:has(#proj-knowledge-h) .attach-chip")).toContainText("Plan summary.pdf");
    await expect(page.locator("section:has(#proj-knowledge-h) .attach-progress")).toHaveCount(0);

    // The first message starts a chat in the project.
    await page.getByPlaceholder("How can I help you today?").fill("Draft an appeal letter");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-assistant")).toHaveCount(1);
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    await expect(page.locator(".chat-head .badge-project")).toHaveText("EOB review");
    await expect(page.locator(".project-chats .conv-row")).toHaveCount(1);
    await expect(page.locator(".conv-list .conv-row")).toHaveCount(0);

    // Back to the project from the badge; a second chat from the row's "+".
    await page.locator(".chat-head .badge-project").click();
    await expect(page.getByRole("heading", { level: 1, name: "EOB review" })).toBeVisible();
    // Recents lists the chat that was just started.
    await expect(page.locator(".project-page")).toContainText("Just now");
    await page.locator(".project-row").first().hover();
    await page.getByRole("button", { name: "New chat in EOB review" }).click();
    await expect(page.getByPlaceholder("How can I help you today?")).toBeVisible();

    // Renaming from the sidebar row changes the page too.
    await page.locator(".project-row").first().hover();
    await page.locator(".project-list").getByRole("button", { name: "Rename project: EOB review" }).click();
    await page.locator(".project-list .rename-form input").fill("EOB appeals");
    await page.locator(".project-list .rename-form").getByRole("button", { name: "Save" }).click();
    await expect(page.locator(".project-list .project-select")).toContainText("EOB appeals");
    await expect(page.getByRole("heading", { level: 1, name: "EOB appeals" })).toBeVisible();

    // Deleting the project keeps the chat, now outside any project.
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Delete project" }).click();
    await expect(page.locator(".project-list .project-select")).toHaveCount(0);
    await expect(page.locator(".conv-list .conv-row")).toHaveCount(1);
    errs.expectNone();
  });
});
