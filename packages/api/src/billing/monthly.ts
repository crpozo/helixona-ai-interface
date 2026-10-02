import type { UsageRow } from "../repos/types.js";

/** "2026-10" for the month of `d` and the previous `n - 1` months, newest first. */
export function monthsBack(d: Date, n: number): string[] {
  const out: string[] = [];
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  return out;
}

export interface MonthUsage {
  month: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  byModel: Record<string, { turns: number; estimatedUsd: number }>;
  byUser: Array<{ userId: string; turns: number; inputTokens: number; outputTokens: number; estimatedUsd: number }>;
}

/** The daily rows of the usage table added up per month, for the months given (a month without rows is all zeros). */
export function aggregateMonths(rows: UsageRow[], months: string[]): MonthUsage[] {
  const out = new Map<string, MonthUsage>(months.map((m) => [m, { month: m, turns: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0, byModel: {}, byUser: [] }]));
  const users = new Map<string, Map<string, MonthUsage["byUser"][number]>>();
  for (const r of rows) {
    const month = r.day.slice(0, 7);
    const m = out.get(month);
    if (!m) continue;
    m.turns += r.turns;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.estimatedUsd += r.estimatedUsd;
    for (const [model, v] of Object.entries(r.byModel ?? {})) {
      const cur = (m.byModel[model] ??= { turns: 0, estimatedUsd: 0 });
      cur.turns += v.turns;
      cur.estimatedUsd += v.estimatedUsd;
    }
    let perUser = users.get(month);
    if (!perUser) users.set(month, (perUser = new Map()));
    const u = perUser.get(r.userId) ?? { userId: r.userId, turns: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
    u.turns += r.turns;
    u.inputTokens += r.inputTokens;
    u.outputTokens += r.outputTokens;
    u.estimatedUsd += r.estimatedUsd;
    perUser.set(r.userId, u);
  }
  for (const [month, perUser] of users) out.get(month)!.byUser = [...perUser.values()].sort((a, b) => b.estimatedUsd - a.estimatedUsd);
  return months.map((m) => out.get(m)!);
}

/** The credits an administrator recorded: what was bought in the Claude Console, and when. */
export interface CreditsRecord {
  purchasedUsd: number;
  /** YYYY-MM-DD: spending from this day on counts against the credits. */
  asOf: string;
  note: string;
  updatedAt: string;
  updatedBy: string;
}

/** Dollars spent from `fromDay` (inclusive) on, from a list of daily amounts. */
export function spentSince(days: Array<{ day: string; usd: number }>, fromDay: string): number {
  return days.filter((d) => d.day >= fromDay).reduce((n, d) => n + d.usd, 0);
}

/** The assistant's own cost estimate per day, from the usage rows. */
export function dailyEstimates(rows: UsageRow[]): Array<{ day: string; usd: number }> {
  const days = new Map<string, number>();
  for (const r of rows) days.set(r.day, (days.get(r.day) ?? 0) + r.estimatedUsd);
  return [...days.entries()].map(([day, usd]) => ({ day, usd })).sort((a, b) => a.day.localeCompare(b.day));
}
