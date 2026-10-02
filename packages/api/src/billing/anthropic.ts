import type { SafeLogger } from "@helixona/core";

/**
 * The organization's cost report from the Anthropic Admin API (curl-only endpoint; needs an Admin
 * API key, which is not the key that sends messages): dollars billed per day, for the billing view.
 * Amounts arrive as decimal strings in cents; a day with no cost is an empty bucket.
 */
export interface CostDay {
  day: string;
  usd: number;
}
export interface CostReport {
  days: CostDay[];
  fetchedAt: string;
}
export interface BillingSource {
  /** Billed amounts per day from `fromDay` (YYYY-MM-DD) up to today. */
  report(fromDay: string): Promise<CostReport>;
}

const BASE = "https://api.anthropic.com/v1/organizations/cost_report";
const CACHE_MS = 15 * 60_000;
const PLACEHOLDER = /^REPLACE_ME/;

/** True when a secret holds a real key rather than the placeholder the infrastructure creates. */
export function isConfiguredKey(value: string | undefined): value is string {
  return !!value && value.trim().length > 0 && !PLACEHOLDER.test(value.trim());
}

export class AnthropicBilling implements BillingSource {
  private cache = new Map<string, { at: number; report: CostReport }>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly log: SafeLogger | null;

  constructor(private readonly opts: { apiKey: string; fetch?: typeof fetch; now?: () => Date; log?: SafeLogger }) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? null;
  }

  async report(fromDay: string): Promise<CostReport> {
    const hit = this.cache.get(fromDay);
    if (hit && this.now().getTime() - hit.at < CACHE_MS) return hit.report;
    const days = new Map<string, number>();
    const start = `${fromDay}T00:00:00Z`;
    const end = new Date(this.now().getTime() + 86_400_000).toISOString().slice(0, 10) + "T00:00:00Z";
    let page: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const url = new URL(BASE);
      url.searchParams.set("starting_at", start);
      url.searchParams.set("ending_at", end);
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", "31");
      if (page) url.searchParams.set("page", page);
      const res = await this.fetchImpl(url, { headers: { "x-api-key": this.opts.apiKey, "anthropic-version": "2023-06-01" } });
      if (!res.ok) {
        this.log?.warn("billing_cost_report_failed", { status: res.status });
        throw new Error(`cost report: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { data?: Array<{ starting_at: string; results?: Array<{ amount: string; currency?: string }> }>; has_more?: boolean; next_page?: string | null };
      for (const bucket of body.data ?? []) {
        const day = bucket.starting_at.slice(0, 10);
        const cents = (bucket.results ?? []).reduce((n, r) => n + (Number(r.amount) || 0), 0);
        // Cents to dollars, rounded to a millionth: sums of decimal strings must not drift.
        days.set(day, Math.round(((days.get(day) ?? 0) + cents / 100) * 1_000_000) / 1_000_000);
      }
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
    const report: CostReport = { days: [...days.entries()].map(([day, usd]) => ({ day, usd })).sort((a, b) => a.day.localeCompare(b.day)), fetchedAt: this.now().toISOString() };
    this.cache.set(fromDay, { at: this.now().getTime(), report });
    return report;
  }
}
