import { expect, type BrowserContext, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** Headers the API requires on every non-GET request (CSRF) plus JSON. */
export const H = { "x-requested-with": "helixona", "content-type": "application/json" };
export type Role = "staff" | "admin";

let seq = 0;
/** A username nobody else in the run uses: the in-memory store is shared by all tests. */
export function uniqueUser(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${(seq++).toString(36)}`;
}

/** Signs the context in through the dev identity provider (cookie shared with the context's pages). */
export async function devLogin(ctx: BrowserContext, username: string, role: Role = "staff"): Promise<void> {
  const r = await ctx.request.post("/api/auth/dev-login", { headers: H, data: { username, role } });
  expect(r.ok(), `dev-login ${username}`).toBeTruthy();
}

/** "Skip training, I already know this" through the API, for tests that are not about the training. */
export async function skipTraining(ctx: BrowserContext): Promise<void> {
  const r = await ctx.request.post("/api/training/attest", { headers: H, data: { attested: true } });
  expect(r.ok(), "attest").toBeTruthy();
}

/** The right answers of the knowledge check, per module (module id -> question number -> letter). */
export const ANSWER_KEY: Record<number, Record<string, string>> = {
  1: { "1": "B" },
  2: { "2": "A" },
  3: { "3": "B", "4": "C" },
  4: { "5": "B", "6": "B", "7": "B" },
  5: { "8": "B", "9": "B", "10": "B" },
  6: { "11": "B" },
  7: { "12": "B" },
};
export const ANSWERS_IN_ORDER = Object.values(ANSWER_KEY).flatMap((m) => Object.values(m));

/** Completes every module through the API (the course UI is covered by training.spec.ts). */
export async function completeTraining(ctx: BrowserContext): Promise<void> {
  for (const [id, answers] of Object.entries(ANSWER_KEY)) {
    const r = await ctx.request.post(`/api/training/modules/${id}`, { headers: H, data: { answers } });
    expect(r.ok(), `module ${id}`).toBeTruthy();
  }
}

export async function samplePdf(text = "Sample document for testing", pages = 1): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) pdf.addPage([612, 792]).drawText(`${text} (page ${i + 1})`, { x: 50, y: 740, size: 14, font });
  return Buffer.from(await pdf.save());
}

/**
 * Collects page errors, console errors and failed requests so a test can assert the page stayed
 * clean. The 401 from /api/me on public pages is the app finding out the visitor is signed out.
 */
export function watchErrors(page: Page): { errors: string[]; expectNone: () => void } {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // The browser logs every 4xx fetch as an error; those are answers the app handles (a refused
    // score, a visitor's 401). Script errors and 5xx (caught below) are what we are after.
    if (m.type() === "error" && !/status of 4\d\d/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  page.on("requestfailed", (r) => {
    // A request the browser abandoned because the page navigated is not a failure of the app.
    const why = r.failure()?.errorText ?? "";
    if (why !== "net::ERR_ABORTED") errors.push(`requestfailed: ${r.method()} ${r.url()} ${why}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 500) errors.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`);
  });
  return { errors, expectNone: () => expect(errors, "page errors").toEqual([]) };
}

/** Phone layouts must never scroll sideways. */
export async function noHorizontalOverflow(page: Page): Promise<void> {
  const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scrollWidth, `horizontal overflow on ${page.url()}`).toBeLessThanOrEqual(innerWidth!);
}
