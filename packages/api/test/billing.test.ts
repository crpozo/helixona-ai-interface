import { describe, expect, it } from "vitest";
import { CircuitBreaker, DEFAULT_CATALOG, FakeProvider, ModelRouter, noopLogger } from "@helixona/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DevIdentityProvider } from "../src/auth/dev.js";
import { SessionService } from "../src/auth/session.js";
import { memoryRepos, MemoryUserDirectory } from "../src/repos/memory.js";
import { MemoryAttachmentStore } from "../src/attachments/store.js";
import { MemoryFeedbackSender } from "../src/feedback.js";
import type { Deps } from "../src/deps.js";
import { AnthropicBilling, isConfiguredKey, type BillingSource } from "../src/billing/anthropic.js";
import { aggregateMonths, monthsBack, spentSince } from "../src/billing/monthly.js";

const H = { "x-requested-with": "helixona", "content-type": "application/json" };
const NOW = new Date("2026-10-02T12:00:00Z");

async function makeApp(billing: BillingSource | null) {
  const config = loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", STORE_MODE: "memory", LLM_MODE: "fake", SESSION_SECRET: "test-secret-test-secret", DAILY_QUOTA_USD: "100", WEB_DIST: "/nonexistent", TRAINING_REQUIRED: "false", BILLING_VIEWER_EMAILS: "Carlos@dev.local, other@dev.local" });
  const repos = memoryRepos();
  const provider = new FakeProvider({ delayMs: 0 });
  const deps: Deps = {
    config, log: noopLogger, catalog: DEFAULT_CATALOG, repos,
    sessions: new SessionService({ repo: repos.sessions, secret: config.SESSION_SECRET!, idleSeconds: config.SESSION_IDLE_SECONDS, absoluteSeconds: config.SESSION_ABSOLUTE_SECONDS }),
    identity: new DevIdentityProvider(), directory: new MemoryUserDirectory(), provider,
    router: new ModelRouter({ catalog: DEFAULT_CATALOG, provider, breaker: new CircuitBreaker(), firstEventTimeoutMs: 2000 }),
    systemPrompt: { text: "test system prompt", version: "v1" },
    attachments: new MemoryAttachmentStore(), passwordAuth: null, feedback: new MemoryFeedbackSender(), billing, now: () => NOW,
  };
  return { app: await buildApp(deps), repos };
}
async function login(app: FastifyInstance, username: string, role: "staff" | "admin"): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", headers: H, payload: { username, role } });
  return `hx_session=${r.cookies.find((c) => c.name === "hx_session")!.value}`;
}
const usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 1.5 };

describe("Months and credits", () => {
  it("counts months back from a date", () => {
    expect(monthsBack(new Date("2026-01-15T00:00:00Z"), 3)).toEqual(["2026-01", "2025-12", "2025-11"]);
  });

  it("adds the daily rows up per month, by user and by model", () => {
    const rows = [
      { userId: "a", day: "2026-10-01", turns: 2, inputTokens: 100, outputTokens: 10, estimatedUsd: 1, byModel: { opus: { turns: 2, estimatedUsd: 1 } } },
      { userId: "b", day: "2026-10-02", turns: 1, inputTokens: 50, outputTokens: 5, estimatedUsd: 3, byModel: { sonnet: { turns: 1, estimatedUsd: 3 } } },
      { userId: "a", day: "2026-09-30", turns: 1, inputTokens: 10, outputTokens: 1, estimatedUsd: 0.5, byModel: { opus: { turns: 1, estimatedUsd: 0.5 } } },
      { userId: "a", day: "2025-01-01", turns: 9, inputTokens: 9, outputTokens: 9, estimatedUsd: 9, byModel: {} },
    ];
    const months = aggregateMonths(rows, ["2026-10", "2026-09", "2026-08"]);
    expect(months.map((m) => [m.month, m.turns, m.estimatedUsd])).toEqual([["2026-10", 3, 4], ["2026-09", 1, 0.5], ["2026-08", 0, 0]]);
    expect(months[0]!.byUser).toEqual([{ userId: "b", turns: 1, inputTokens: 50, outputTokens: 5, estimatedUsd: 3 }, { userId: "a", turns: 2, inputTokens: 100, outputTokens: 10, estimatedUsd: 1 }]);
    expect(months[0]!.byModel).toEqual({ opus: { turns: 2, estimatedUsd: 1 }, sonnet: { turns: 1, estimatedUsd: 3 } });
    expect(spentSince([{ day: "2026-09-14", usd: 5 }, { day: "2026-09-15", usd: 2 }, { day: "2026-10-01", usd: 1 }], "2026-09-15")).toBe(3);
  });

  it("reads Anthropic's cost report page by page, in cents, and keeps it for a while", async () => {
    const calls: string[] = [];
    const pages: Record<string, unknown> = {
      first: { data: [{ starting_at: "2026-09-30T00:00:00Z", ending_at: "2026-10-01T00:00:00Z", results: [{ amount: "123.45", currency: "USD" }, { amount: "100", currency: "USD" }] }, { starting_at: "2026-10-01T00:00:00Z", ending_at: "2026-10-02T00:00:00Z", results: [] }], has_more: true, next_page: "p2" },
      p2: { data: [{ starting_at: "2026-10-02T00:00:00Z", ending_at: "2026-10-03T00:00:00Z", results: [{ amount: "50", currency: "USD" }] }], has_more: false, next_page: null },
    };
    const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-admin-test");
      const body = pages[url.searchParams.get("page") ?? "first"];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const billing = new AnthropicBilling({ apiKey: "sk-ant-admin-test", fetch: fetchImpl, now: () => NOW });
    const r = await billing.report("2026-09-30");
    expect(r.days).toEqual([{ day: "2026-09-30", usd: 2.2345 }, { day: "2026-10-01", usd: 0 }, { day: "2026-10-02", usd: 0.5 }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("starting_at=2026-09-30T00%3A00%3A00Z");
    expect(calls[0]).toContain("bucket_width=1d");
    expect(calls[1]).toContain("page=p2");
    await billing.report("2026-09-30");
    expect(calls).toHaveLength(2);
    // A failing report is an error the route turns into a note, never a crash.
    const failing = new AnthropicBilling({ apiKey: "k", fetch: (async () => new Response("no", { status: 401 })) as typeof fetch, now: () => NOW });
    await expect(failing.report("2026-09-01")).rejects.toThrow("HTTP 401");
    expect([isConfiguredKey(undefined), isConfiguredKey(""), isConfiguredKey("REPLACE_ME_WITH_ANTHROPIC_ADMIN_API_KEY"), isConfiguredKey("sk-ant-admin01-x")]).toEqual([false, false, false, true]);
  });

  it("shows the billing view only to the administrators named in the settings, with the months, the credits and what is left", async () => {
    const report: BillingSource = { report: async () => ({ days: [{ day: "2026-09-20", usd: 40 }, { day: "2026-10-01", usd: 12.5 }], fetchedAt: NOW.toISOString() }) };
    const { app, repos } = await makeApp(report);
    const carlos = await login(app, "carlos", "admin");
    const ana = await login(app, "ana", "admin");
    const staff = await login(app, "carlos", "staff");
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: carlos } })).json().billing).toBe(true);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: ana } })).json().billing).toBe(false);
    expect((await app.inject({ method: "GET", url: "/api/admin/billing", headers: { cookie: ana } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/admin/billing", headers: { cookie: staff } })).statusCode).toBe(403);

    await repos.usage.add("dev-ana", "2026-10-01", "anthropic.claude-opus-5-5", usage);
    await repos.usage.add("dev-ana", "2026-10-02", "anthropic.claude-opus-5-5", { ...usage, estimatedUsd: 2 });
    await repos.usage.add("dev-bruno", "2026-10-02", "anthropic.claude-sonnet-5-5", { ...usage, estimatedUsd: 0.25 });
    await repos.usage.add("dev-ana", "2026-09-10", "anthropic.claude-opus-5-5", { ...usage, estimatedUsd: 4 });
    const r1 = (await app.inject({ method: "GET", url: "/api/admin/billing", headers: { cookie: carlos } })).json();
    expect(r1.months).toHaveLength(12);
    expect(r1.months[0]).toMatchObject({ month: "2026-10", turns: 3, inputTokens: 3000, outputTokens: 300, estimatedUsd: 3.75 });
    expect(r1.months[0].byUser.map((u: { userId: string; estimatedUsd: number }) => [u.userId, u.estimatedUsd])).toEqual([["dev-ana", 3.5], ["dev-bruno", 0.25]]);
    expect(r1.months[0].byModel).toEqual({ "anthropic.claude-opus-5-5": { turns: 2, estimatedUsd: 3.5 }, "anthropic.claude-sonnet-5-5": { turns: 1, estimatedUsd: 0.25 } });
    expect(r1.months[1]).toMatchObject({ month: "2026-09", turns: 1, estimatedUsd: 4 });
    expect(r1.credits).toBeNull();
    expect(r1.remaining).toBeNull();
    expect(r1.anthropic).toMatchObject({ configured: true, error: null, sinceAnchorUsd: null });
    expect(r1.anthropic.months.slice(0, 2)).toEqual([{ month: "2026-10", costUsd: 12.5 }, { month: "2026-09", costUsd: 40 }]);

    // The credits bought, and the balance from the billed amounts since that day.
    const put = await app.inject({ method: "PUT", url: "/api/admin/billing/credits", headers: { ...H, cookie: carlos }, payload: { purchasedUsd: 500, asOf: "2026-09-15", note: "Bought in the console" } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ purchasedUsd: 500, asOf: "2026-09-15", note: "Bought in the console", updatedBy: "carlos" });
    const r2 = (await app.inject({ method: "GET", url: "/api/admin/billing", headers: { cookie: carlos } })).json();
    expect(r2.remaining).toEqual({ usd: 447.5, spentUsd: 52.5, basis: "anthropic" });
    expect(r2.anthropic.sinceAnchorUsd).toBe(52.5);
    const audit = repos.audit.events.filter((e) => e.action === "admin_billing_credits");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.meta).toEqual({ purchasedUsd: 500, asOf: "2026-09-15" });
    expect(JSON.stringify(audit)).not.toContain("console");
    expect((await app.inject({ method: "PUT", url: "/api/admin/billing/credits", headers: { ...H, cookie: ana }, payload: { purchasedUsd: 1, asOf: "2026-09-15" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/admin/billing/credits", headers: { ...H, cookie: carlos }, payload: { purchasedUsd: -1, asOf: "2026-09-15" } })).statusCode).toBe(400);
  });

  it("without the Admin API key, what is left comes from the assistant's own estimate", async () => {
    const { app, repos } = await makeApp(null);
    const carlos = await login(app, "carlos", "admin");
    await repos.usage.add("dev-ana", "2026-09-14", "anthropic.claude-opus-5-5", { ...usage, estimatedUsd: 100 });
    await repos.usage.add("dev-ana", "2026-09-15", "anthropic.claude-opus-5-5", { ...usage, estimatedUsd: 4 });
    await repos.usage.add("dev-ana", "2026-10-02", "anthropic.claude-opus-5-5", { ...usage, estimatedUsd: 1.5 });
    await app.inject({ method: "PUT", url: "/api/admin/billing/credits", headers: { ...H, cookie: carlos }, payload: { purchasedUsd: 100, asOf: "2026-09-15" } });
    const r = (await app.inject({ method: "GET", url: "/api/admin/billing", headers: { cookie: carlos } })).json();
    expect(r.anthropic).toEqual({ configured: false, months: [], sinceAnchorUsd: null, fetchedAt: null, error: null });
    expect(r.remaining).toEqual({ usd: 94.5, spentUsd: 5.5, basis: "estimate" });
  });
});
