import { expect, test } from "@playwright/test";
import { devLogin, noHorizontalOverflow, skipTraining, uniqueUser, watchErrors } from "./helpers";

test.describe("Phone layout", () => {
  test("the sidebar is a drawer, the chat works and no page scrolls sideways", async ({ page, context }) => {
    const errs = watchErrors(page);
    await page.goto("/login", { waitUntil: "load" });
    await noHorizontalOverflow(page);
    await devLogin(context, uniqueUser("e2e-mobile"), "staff");
    await page.goto("/", { waitUntil: "load" });
    await expect(page.locator(".training-gate")).toBeVisible();
    await noHorizontalOverflow(page);
    await skipTraining(context);
    await page.reload({ waitUntil: "load" });
    await expect(page.locator(".home-start")).toBeVisible();

    const drawer = page.locator("#sidebar");
    await expect(drawer).not.toHaveClass(/open/);
    await page.getByRole("button", { name: /Conversations/ }).click();
    await expect(drawer).toHaveClass(/open/);
    await page.getByRole("button", { name: "Close panel" }).click();
    await expect(drawer).not.toHaveClass(/open/);

    await page.getByPlaceholder("Write a message…").fill("Hello from a phone");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-assistant")).toHaveCount(1);
    await expect(page.locator(".msg-assistant")).toContainText("Simulated reply");
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    await noHorizontalOverflow(page);

    for (const route of ["/training", "/documentation", "/documentation/risk-analysis"]) {
      await page.goto(route, { waitUntil: "load" });
      await expect(page.locator("h1").first()).toBeVisible();
      await noHorizontalOverflow(page);
    }
    errs.expectNone();
  });
});
