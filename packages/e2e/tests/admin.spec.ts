import { expect, test } from "@playwright/test";
import { devLogin, skipTraining, uniqueUser, watchErrors } from "./helpers";

test.describe("Administration", () => {
  test("users, temporary password, disable, and the training log with a paper completion", async ({ page, context }) => {
    const errs = watchErrors(page);
    const adminName = uniqueUser("e2e-admin");
    await devLogin(context, adminName, "admin");
    await skipTraining(context);
    await page.goto("/", { waitUntil: "load" });
    await page.getByRole("link", { name: "Administration" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    await expect(page.locator("tr", { hasText: adminName })).toBeVisible();

    // A new user is invited.
    const email = `${uniqueUser("paper")}@clinic.test`;
    await page.locator("#nu-name").fill("Paper Person");
    await page.locator("#nu-email").fill(email);
    await page.locator("#nu-role").selectOption("staff");
    await page.getByRole("button", { name: "Create user" }).click();
    const row = page.locator("#users-title ~ * tr, table tr", { hasText: email }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Invited");

    // The temporary password: a confirm first, then a prompt that shows it once; it never appears on the page afterwards.
    let shown = "";
    const onPasswordDialogs = (d: import("@playwright/test").Dialog) => {
      if (d.type() === "prompt") shown = d.defaultValue();
      void d.accept();
    };
    page.on("dialog", onPasswordDialogs);
    await row.getByRole("button", { name: "Temporary password" }).click();
    await expect.poll(() => shown).not.toBe("");
    page.off("dialog", onPasswordDialogs);
    expect(await page.content()).not.toContain(shown);

    // Disable (asks first) and enable.
    const acceptAll = (d: import("@playwright/test").Dialog) => void d.accept();
    page.on("dialog", acceptAll);
    await row.getByRole("button", { name: "Disable" }).click();
    await expect(row.getByRole("button", { name: "Enable" })).toBeVisible();
    await expect(row).toContainText("Disabled");
    await row.getByRole("button", { name: "Enable" }).click();
    await expect(row.getByRole("button", { name: "Disable" })).toBeVisible();
    page.off("dialog", acceptAll);
    // Nobody disables their own account from here.
    await expect(page.locator("tr", { hasText: adminName }).getByRole("button", { name: "Disable" })).toHaveCount(0);

    // Training log: the new user has not started; a paper completion below the passing score is refused.
    const log = page.locator(".training-log tr", { hasText: email });
    await expect(log).toContainText("Not started");
    const answers = ["2026-09-20", "9"];
    const onDialog = (d: import("@playwright/test").Dialog) => void d.accept(answers.shift());
    page.on("dialog", onDialog);
    await log.getByRole("button", { name: "Record paper completion" }).click();
    await expect(page.getByText(/A score of 10 of 12 or better is required/)).toBeVisible();
    answers.push("2026-09-20", "12");
    await log.getByRole("button", { name: "Record paper completion" }).click();
    await expect(log).toContainText("Completed (paper)");
    await expect(log).toContainText("Sep 20, 2026");
    page.off("dialog", onDialog);

    await page.getByRole("link", { name: /Back/ }).or(page.getByRole("button", { name: /Back/ })).first().click();
    await expect(page.locator(".home-start")).toBeVisible();
    errs.expectNone();
  });
});
