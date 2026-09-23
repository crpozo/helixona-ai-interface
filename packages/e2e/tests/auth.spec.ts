import { expect, test } from "@playwright/test";
import { devLogin, skipTraining, uniqueUser, watchErrors } from "./helpers";

test.describe("Sign-in and session", () => {
  test("private routes send a visitor to the sign-in page; the documentation stays public", async ({ page }) => {
    const errs = watchErrors(page);
    for (const route of ["/", "/admin", "/training"]) {
      await page.goto(route, { waitUntil: "load" });
      await expect(page).toHaveURL(/\/login$/);
    }
    await page.goto("/documentation", { waitUntil: "load" });
    await expect(page).toHaveURL(/\/documentation$/);
    await expect(page.getByRole("heading", { level: 1, name: "Compliance documents" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
    await page.goto("/does-not-exist", { waitUntil: "load" });
    await expect(page).toHaveURL(/\/login$/);
    errs.expectNone();
  });

  test("the sign-in page renders; a new user lands on the training gate; sign out returns to the sign-in page", async ({ page, context }) => {
    const errs = watchErrors(page);
    await page.goto("/login", { waitUntil: "load" });
    await expect(page.locator("#login-email")).toBeVisible();
    await expect(page.locator("#login-password")).toBeVisible();
    await expect(page.getByRole("link", { name: "Documentation", exact: true })).toBeVisible();
    // The real sign-in is Cognito (email, password, authenticator); here the dev identity provider signs the user in.
    await devLogin(context, uniqueUser("e2e-auth"), "staff");
    await page.goto("/", { waitUntil: "load" });
    await expect(page.locator(".training-gate")).toBeVisible();
    await expect(page.locator(".training-gate h1")).toContainText("One step before you start");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/", { waitUntil: "load" });
    await expect(page).toHaveURL(/\/login$/);
    errs.expectNone();
  });

  test("a staff user never sees the administration page", async ({ page, context }) => {
    await devLogin(context, uniqueUser("e2e-staff"), "staff");
    await skipTraining(context);
    await page.goto("/", { waitUntil: "load" });
    await expect(page.locator(".home-start")).toBeVisible();
    await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);
    await page.goto("/admin", { waitUntil: "load" });
    await expect(page.getByRole("heading", { name: "Users" })).toHaveCount(0);
    await expect(page.locator(".home-start")).toBeVisible();
  });
});
