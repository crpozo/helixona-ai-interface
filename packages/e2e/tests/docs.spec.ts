import { expect, test } from "@playwright/test";
import { ANSWERS_IN_ORDER, devLogin, samplePdf, skipTraining, uniqueUser, watchErrors } from "./helpers";

test.describe("Documentation", () => {
  test("visitors read the three documents, download the Word files and see the agreements' status", async ({ page, context }) => {
    const errs = watchErrors(page);
    await page.goto("/documentation", { waitUntil: "load" });
    for (const title of ["HIPAA Security Risk Analysis", "HIPAA Policies and Procedures", "Workforce Training"]) {
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
    }
    const downloads = await page.getByRole("link", { name: "Download Word file" }).evaluateAll((els) => els.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
    expect(downloads).toHaveLength(3);
    for (const href of downloads) {
      const r = await context.request.get(href);
      expect(r.status(), href).toBe(200);
      expect(r.headers()["content-type"], href).toContain("wordprocessingml");
    }
    await expect(page.getByRole("heading", { name: "Business associate agreements" })).toBeVisible();
    await expect(page.locator(".agreement-card")).toHaveCount(2);
    await expect(page.getByRole("link", { name: "Download PDF" })).toHaveCount(0);
    await expect(page.getByText("Upload PDF")).toHaveCount(0);
    await expect(page.locator(".docs-how")).not.toContainText(/\bsign\b|signed copies/i);

    await page.getByRole("link", { name: "Read online" }).first().click();
    await expect(page).toHaveURL(/\/documentation\/risk-analysis$/);
    await expect(page.getByRole("heading", { level: 2, name: "8. Approval" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Signature" })).toHaveCount(0);
    await page.getByRole("link", { name: "All documents" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Compliance documents" })).toBeVisible();
    errs.expectNone();
  });

  test("signed-in staff take the knowledge check online: fail with feedback, reset, pass", async ({ page, context }) => {
    const errs = watchErrors(page);
    await devLogin(context, uniqueUser("e2e-check"), "staff");
    await page.goto("/documentation/workforce-training", { waitUntil: "load" });
    const submit = page.getByRole("button", { name: "Submit answers" });
    await expect(submit).toBeDisabled();
    await expect(page.getByRole("heading", { name: /Answer key/ })).toHaveCount(0);
    for (let n = 1; n <= 12; n++) await page.locator(`input[name="q${n}"][value="A"]`).check();
    await submit.click();
    await expect(page.locator(".quiz-result")).toContainText("Score: 1 of 12. Not passed (10 needed).");
    await expect(page.locator(".quiz-verdict.ko").first()).toContainText("Not quite.");
    await page.getByRole("button", { name: "Reset answers and try again" }).click();
    await expect(page.locator(".quiz-verdict")).toHaveCount(0);
    for (let n = 1; n <= 12; n++) await page.locator(`input[name="q${n}"][value="${ANSWERS_IN_ORDER[n - 1]}"]`).check();
    await page.getByRole("button", { name: "Submit answers" }).click();
    await expect(page.locator(".quiz-result")).toContainText("Score: 12 of 12. Passed.");
    await expect(page.locator(".training-status").first()).toContainText("Completed. Passed on");
    await expect(page.getByRole("button", { name: /Sign/ })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to the assistant" }).click();
    await expect(page.locator(".home-start")).toBeVisible();
    errs.expectNone();
  });

  test("an administrator keeps the clinic's copy of a BAA on file and staff download it", async ({ browser }) => {
    const adminCtx = await browser.newContext();
    await devLogin(adminCtx, uniqueUser("e2e-agr-admin"), "admin");
    await skipTraining(adminCtx);
    const admin = await adminCtx.newPage();
    const errs = watchErrors(admin);
    await admin.goto("/documentation", { waitUntil: "load" });
    const aws = admin.locator(".agreement-card", { hasText: "AWS Business Associate Addendum" });
    await expect(aws.getByText("Upload PDF")).toBeVisible();
    await aws.locator('input[type="file"]').setInputFiles({ name: "aws-baa.pdf", mimeType: "application/pdf", buffer: await samplePdf("AWS BAA") });
    await expect(aws.getByRole("link", { name: "Download PDF" })).toBeVisible();
    await expect(aws.locator(".agreement-meta")).toContainText("PDF, ");
    await expect(aws.getByText("Replace PDF")).toBeVisible();
    errs.expectNone();

    const staffCtx = await browser.newContext();
    await devLogin(staffCtx, uniqueUser("e2e-agr-staff"), "staff");
    await skipTraining(staffCtx);
    const staff = await staffCtx.newPage();
    await staff.goto("/documentation", { waitUntil: "load" });
    const link = staff.locator(".agreement-card", { hasText: "AWS Business Associate Addendum" }).getByRole("link", { name: "Download PDF" });
    await expect(link).toBeVisible();
    await expect(staff.getByText("Upload PDF")).toHaveCount(0);
    const r = await staffCtx.request.get((await link.getAttribute("href"))!);
    expect(r.status()).toBe(200);
    expect(r.headers()["content-type"]).toBe("application/pdf");
    expect(r.headers()["content-disposition"]).toContain("AWS-Business-Associate-Addendum.pdf");

    admin.once("dialog", (d) => void d.accept());
    await aws.getByRole("button", { name: "Remove copy" }).click();
    await expect(aws.getByRole("link", { name: "Download PDF" })).toHaveCount(0);
    await adminCtx.close();
    await staffCtx.close();
  });
});
