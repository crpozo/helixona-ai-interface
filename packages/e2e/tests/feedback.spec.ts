import { expect, test } from "@playwright/test";
import { devLogin, skipTraining, uniqueUser, watchErrors } from "./helpers";

test.describe("Report a bug", () => {
  test("the sidebar opens a small text box and the report is sent", async ({ page, context }) => {
    const errs = watchErrors(page);
    await devLogin(context, uniqueUser("e2e-bug"), "staff");
    await skipTraining(context);
    await page.goto("/", { waitUntil: "load" });
    await expect(page.locator("#bug-report-form")).toHaveCount(0);
    await page.getByRole("button", { name: "Report a bug" }).click();
    const box = page.locator("#bug-report-text");
    await expect(box).toBeFocused();
    const send = page.locator("#bug-report-form").getByRole("button", { name: "Send" });
    await box.fill("short");
    await expect(send).toBeDisabled();
    await box.fill("The Send button does nothing after I attach a PDF on the start screen.");
    await expect(send).toBeEnabled();
    await send.click();
    await expect(page.locator(".bug-report-sent")).toHaveText("Sent. Thank you!");
    // Cancel closes the box without sending.
    await expect(page.locator("#bug-report-form")).toHaveCount(0, { timeout: 8000 });
    await page.getByRole("button", { name: "Report a bug" }).click();
    await page.locator("#bug-report-form").getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("#bug-report-form")).toHaveCount(0);
    errs.expectNone();
  });
});
