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
    await expect(page.getByRole("tab", { name: "Users", selected: true })).toBeVisible();
    // An administrator not named in the settings has no billing tab.
    await expect(page.getByRole("tab", { name: "Billing" })).toHaveCount(0);
    // The signed-in administrator appears in the Users table, with the training attested.
    const own = page.locator(".users-table tr", { hasText: adminName }).first();
    await expect(own).toBeVisible();
    await expect(own).toContainText("Skipped (attested by user)");
    // System: bug reports, where they go and that the inbox is confirmed (memory sender in this environment).
    await page.getByRole("tab", { name: "System" }).click();
    await expect(page.getByRole("heading", { name: "Bug reports" })).toBeVisible();
    await expect(page.getByText(/Delivery confirmed/)).toBeVisible();
    await page.getByRole("button", { name: "Send a test report" }).click();
    await expect(page.getByText(/Test report sent/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Failed turns" })).toBeVisible();
    await expect(page.getByText("No failed turns that day.")).toBeVisible();
    // Usage: the day's tables.
    await page.getByRole("tab", { name: "Usage" }).click();
    await expect(page.locator("#usage-day")).toBeVisible();
    await page.getByRole("tab", { name: "Users" }).click();

    // A new user is invited from the form behind "Add a user".
    const email = `${uniqueUser("paper")}@clinic.test`;
    await page.getByRole("button", { name: "Add a user" }).click();
    await page.locator("#nu-name").fill("Paper Person");
    await page.locator("#nu-email").fill(email);
    await page.locator("#nu-role").selectOption("staff");
    await page.getByRole("button", { name: "Create user" }).click();
    const row = page.locator(".users-table tr", { hasText: email }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText("Invited");
    const openMenu = async () => {
      await row.getByRole("button", { name: `Options for ${email}` }).click();
    };

    // The temporary password: a confirm first, then a prompt that shows it once; it never appears on the page afterwards.
    let shown = "";
    const onPasswordDialogs = (d: import("@playwright/test").Dialog) => {
      if (d.type() === "prompt") shown = d.defaultValue();
      void d.accept();
    };
    page.on("dialog", onPasswordDialogs);
    await openMenu();
    await page.getByRole("menuitem", { name: "Temporary password" }).click();
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
    // Nobody disables their own account from here: the button on the administrator's own row is off.
    await expect(page.locator("tr", { hasText: adminName }).getByRole("button", { name: "Disable" })).toBeDisabled();

    // Training, in the same row: the new user has not started; a paper completion below the passing score is refused.
    await expect(row).toContainText("Not started");
    const answers = ["2026-09-20", "9"];
    const onDialog = (d: import("@playwright/test").Dialog) => void d.accept(answers.shift());
    page.on("dialog", onDialog);
    await openMenu();
    await page.getByRole("menuitem", { name: "Record paper completion" }).click();
    await expect(page.getByText(/A score of 10 of 12 or better is required/)).toBeVisible();
    answers.push("2026-09-20", "12");
    await openMenu();
    await page.getByRole("menuitem", { name: "Record paper completion" }).click();
    await expect(row).toContainText("Completed (paper)");
    await expect(row).toContainText("Sep 20, 2026");
    page.off("dialog", onDialog);

    await page.getByRole("link", { name: /Back/ }).or(page.getByRole("button", { name: /Back/ })).first().click();
    await expect(page.locator(".home-start")).toBeVisible();
    errs.expectNone();
  });

  test("usage by month and the credits left, for the administrator named in the settings", async ({ page, context }) => {
    const errs = watchErrors(page);
    await devLogin(context, "billing", "admin");
    await skipTraining(context);
    await page.goto("/", { waitUntil: "load" });
    // One turn, so this month has usage.
    await page.getByPlaceholder("Write a message…").fill("A short question");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.locator(".msg-assistant").first()).toContainText("Simulated reply");
    // The usage row is written when the turn ends.
    await expect(page.locator(".composer-stop")).toHaveCount(0);
    await page.getByRole("link", { name: "Administration" }).click();
    // Usage by month, behind the Day | Month switch.
    await page.getByRole("tab", { name: "Usage" }).click();
    await page.getByRole("button", { name: "Month", exact: true }).click();
    const thisMonth = new Date().toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
    const months = page.locator(".billing-months");
    await expect(months).toContainText(thisMonth);
    await expect(months.locator("tbody tr").first().locator("td").nth(1)).not.toHaveText("0");
    // The detail of the month names the user.
    await expect(page.locator(".usage-by-user tbody")).toContainText("billing");
    // Billing: the month against the spend limit, as in the Claude Console.
    await page.getByRole("tab", { name: "Billing" }).click();
    await expect(page.getByText("No monthly spend limit recorded yet")).toBeVisible();
    await page.getByLabel("Monthly spend limit (USD)").fill("1000");
    await page.getByRole("button", { name: "Save limit" }).click();
    await expect(page.locator(".billing-budget .billing-remaining")).toContainText(/\$0\.\d\d of \$1,000\.00 used in .* · \$(1,000\.00|99\d\.\d\d) left/);
    await expect(page.locator(".budget-bar")).toHaveAttribute("aria-valuenow", "0");
    await expect(page.locator(".budget-pct")).toHaveText("0% used");
    await expect(page.getByRole("link", { name: /Billing: balance, auto-reload, spend limit/ })).toHaveAttribute("href", "https://console.anthropic.com/settings/billing");
    errs.expectNone();
  });
});
