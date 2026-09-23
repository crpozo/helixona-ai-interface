import { expect, test } from "@playwright/test";
import { ANSWER_KEY, devLogin, uniqueUser, watchErrors } from "./helpers";

test.describe("Workforce training", () => {
  test("a new user is gated, takes the course module by module and is let in when done", async ({ page, context }) => {
    const errs = watchErrors(page);
    await devLogin(context, uniqueUser("e2e-course"), "staff");
    await page.goto("/", { waitUntil: "load" });
    await expect(page.locator(".training-gate")).toBeVisible();
    // Saying it is done does not make it so.
    await page.getByRole("button", { name: "I have completed it" }).click();
    await expect(page.locator(".training-gate")).toBeVisible();

    await page.getByRole("link", { name: "Start the training" }).click();
    await expect(page).toHaveURL(/\/training$/);
    await expect(page.locator(".course-step.current")).toContainText("Module 1");
    // Later steps are locked until the previous module is complete.
    await expect(page.locator(".course-step").nth(1).locator("button")).toBeDisabled();

    for (let m = 1; m <= 7; m++) {
      await expect(page.locator(".course-card .eyebrow")).toContainText(`Module ${m} of 7`);
      await page.getByRole("button", { name: "Continue to the questions" }).click();
      if (m === 1) {
        // A wrong answer shows feedback and a reset; the module stays open.
        await page.locator('input[name="q1"][value="A"]').check();
        await page.getByRole("button", { name: "Check answers" }).click();
        await expect(page.locator(".quiz-verdict.ko")).toBeVisible();
        await expect(page.locator(".quiz-result")).toContainText("0 of 1 correct");
        await page.getByRole("button", { name: "Reset answers and try again" }).click();
        await expect(page.locator(".quiz-verdict")).toHaveCount(0);
      }
      for (const [n, letter] of Object.entries(ANSWER_KEY[m]!)) await page.locator(`input[name="q${n}"][value="${letter}"]`).check();
      await page.getByRole("button", { name: "Check answers" }).click();
      await expect(page.locator(".quiz-result")).toContainText("Module complete");
      await page.getByRole("button", { name: m === 7 ? "Continue" : "Next module" }).click();
    }
    // Staff: no administrator section; the quick reference, then the completion screen.
    await expect(page.locator(".course-step.current")).toContainText("Quick reference");
    await expect(page.locator(".course-step", { hasText: "For administrators only" })).toHaveCount(0);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator(".course-done h1")).toHaveText("Training complete");
    await expect(page.locator(".course-done")).toContainText("First-attempt score: 11 of 12");
    await expect(page.locator(".course-done")).toContainText("nothing to sign");
    await expect(page.locator(".login-bar-note")).toHaveText("7 of 7 modules");

    await page.getByRole("button", { name: "Go to the assistant" }).click();
    await expect(page.locator(".home-start")).toBeVisible();
    await expect(page.locator(".training-gate")).toHaveCount(0);
    // Coming back shows the completion, with every module open for review.
    await page.getByRole("link", { name: "Training" }).click();
    await expect(page.locator(".course-step.current")).toContainText("Training complete");
    await expect(page.locator(".course-step.done")).toHaveCount(9);
    errs.expectNone();
  });

  test("progress is saved: reloading the course lands on the first pending module", async ({ page, context }) => {
    await devLogin(context, uniqueUser("e2e-resume"), "staff");
    await page.goto("/training", { waitUntil: "load" });
    for (const m of [1, 2]) {
      await page.getByRole("button", { name: "Continue to the questions" }).click();
      for (const [n, letter] of Object.entries(ANSWER_KEY[m]!)) await page.locator(`input[name="q${n}"][value="${letter}"]`).check();
      await page.getByRole("button", { name: "Check answers" }).click();
      await page.getByRole("button", { name: "Next module" }).click();
    }
    await page.reload({ waitUntil: "load" });
    await expect(page.locator(".course-step.current")).toContainText("Module 3");
    await expect(page.locator(".login-bar-note")).toHaveText("2 of 7 modules");
    // Leaving mid-way keeps the gate up.
    await page.getByRole("link", { name: "Back to the assistant" }).click();
    await expect(page.locator(".training-gate")).toBeVisible();
  });

  test("skipping records an attestation and unlocks the assistant", async ({ page, context }) => {
    await devLogin(context, uniqueUser("e2e-skip"), "admin");
    await page.goto("/", { waitUntil: "load" });
    page.once("dialog", (d) => void d.dismiss());
    await page.getByRole("button", { name: "Skip training, I already know this" }).click();
    await expect(page.locator(".training-gate")).toBeVisible();
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("button", { name: "Skip training, I already know this" }).click();
    await expect(page.locator(".home-start")).toBeVisible();
    await page.goto("/documentation/workforce-training", { waitUntil: "load" });
    await expect(page.locator(".training-status").first()).toContainText("Training skipped");
  });
});
