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
    // An administrator not named in the settings has no billing view.
    await expect(page.getByRole("heading", { name: "Usage by month and credits" })).toHaveCount(0);
    // The signed-in administrator appears in the Users table (and, having attested the training, in the log).
    await expect(page.locator("tr", { hasText: adminName }).first()).toBeVisible();
    // Bug reports: where they go and that the inbox is confirmed (memory sender in this environment).
    await expect(page.getByRole("heading", { name: "Bug reports" })).toBeVisible();
    await expect(page.getByText(/Delivery confirmed/)).toBeVisible();
    await page.getByRole("button", { name: "Send a test report" }).click();
    await expect(page.getByText(/Test report sent/)).toBeVisible();

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
    // Nobody disables their own account from here: the button on the administrator's own row is off.
    await expect(page.locator("tr", { hasText: adminName }).getByRole("button", { name: "Disable" })).toBeDisabled();

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
    await expect(page.getByRole("heading", { name: "Usage by month and credits" })).toBeVisible();
    const thisMonth = new Date().toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
    const months = page.locator(".billing-months");
    await expect(months).toContainText(thisMonth);
    await expect(months.locator("tbody tr").first().locator("td").nth(1)).not.toHaveText("0");
    await expect(page.getByText("No credits recorded yet")).toBeVisible();
    await page.getByLabel("Credits purchased (USD)").fill("500");
    await page.getByLabel("As of").fill("2026-01-01");
    await page.getByLabel("Note").fill("Bought in the console");
    await page.getByRole("button", { name: "Save credits" }).click();
    // The fake turn costs a fraction of a cent, so the credits are (nearly) whole.
    await expect(page.locator(".billing-remaining")).toContainText(/\$(499\.\d\d|500\.00) left/);
    await expect(page.getByText(/Bought \$500\.00 as of 2026-01-01 \(Bought in the console\); spent since then \$0\.00 according to this assistant's own estimate/)).toBeVisible();
    // The detail of the month names the user.
    await expect(page.locator(".billing tbody").nth(1)).toContainText("billing");
    errs.expectNone();
  });
});
