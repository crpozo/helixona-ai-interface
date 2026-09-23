import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * End-to-end tests run against the real API (dev authentication, in-memory store, fake model that
 * streams a simulated reply) serving the built web app. Build first: `npm run build` at the root.
 * The browser is real Chromium; Playwright installs it with `npx playwright install chromium`.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const port = Number(process.env.E2E_PORT ?? 3199);
const baseURL = `http://127.0.0.1:${port}`;
// Inside a sandbox with an outbound proxy the browser must talk to localhost directly.
const proxyArgs = process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? ["--proxy-server=direct://", "--proxy-bypass-list=*"] : [];
// A pre-installed Chromium (E2E_CHROMIUM, or the sandbox default) instead of the build Playwright would download.
const executablePath = [process.env.E2E_CHROMIUM, "/opt/pw-browsers/chromium"].find((p) => p && fs.existsSync(p));

export default defineConfig({
  testDir: path.join(here, "tests"),
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 3,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  outputDir: path.join(here, "test-results"),
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    launchOptions: { args: proxyArgs, ...(executablePath ? { executablePath } : {}) },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["iPhone 13"], defaultBrowserType: "chromium" }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: `node ${path.join(root, "packages", "api", "dist", "server.js")}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      NODE_ENV: "development",
      AUTH_MODE: "dev",
      STORE_MODE: "memory",
      LLM_MODE: "fake",
      FAKE_DELAY_MS: "40",
      PORT: String(port),
      WEB_DIST: path.join(root, "packages", "web", "dist"),
      SESSION_SECRET: "e2e-session-secret-e2e-session-secret-e2e-session-secret-0000",
      LOG_LEVEL: "warn",
    },
  },
});
