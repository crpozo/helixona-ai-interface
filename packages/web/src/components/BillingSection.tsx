import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { BillingReport, Me } from "../lib/types";
import { ApiError, adminBilling, adminSetBudget } from "../lib/api";
import { UsageTables } from "./UsageTables";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("en-US");
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");

/** "2026-10" → "Oct 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** The billing report, loaded once for the page and shared by the Usage and Billing tabs. */
export function useBillingReport(enabled: boolean) {
  const [report, setReport] = useState<BillingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    setError(null);
    try {
      setReport(await adminBilling());
    } catch (e) {
      setError(errMsg(e));
    }
  }, [enabled]);
  useEffect(() => {
    void load();
  }, [load]);
  return { report, error, reload: load };
}

interface BudgetProps {
  report: BillingReport | null;
  error: string | null;
  reload: () => Promise<void>;
}

/** The first day of next month, when the Claude Console resets the monthly spend. */
function resetLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, m ?? 1, 1)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The month's spend against the organization's monthly spend limit, the way the Claude Console shows
 * it (Billing, Spend limits). The limit is recorded here once so the bar matches the console; when it
 * is reached, Anthropic refuses every request until the 1st of the next month.
 */
export function BudgetAndCredits({ report, error, reload }: BudgetProps) {
  const [budgetInput, setBudgetInput] = useState("");
  const [budgetSaved, setBudgetSaved] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (report?.budget) setBudgetInput((v) => v || String(report.budget!.monthlyUsd));
  }, [report]);

  const saveBudget = async (e: FormEvent) => {
    e.preventDefault();
    setBudgetSaved(null);
    setLocalError(null);
    try {
      await adminSetBudget({ monthlyUsd: Number(budgetInput) });
      setBudgetSaved("Limit saved.");
      await reload();
    } catch (err) {
      setLocalError(errMsg(err));
    }
  };

  const shownError = localError ?? error;
  if (!report) return shownError ? <p className="notice notice-error" role="alert">{shownError}</p> : <p className="muted">Loading…</p>;
  const b = report.budget;
  const share = b && b.monthlyUsd > 0 ? b.spentUsd / b.monthlyUsd : 0;
  const pct = Math.min(100, Math.round(share * 100));
  return (
    <div className="billing">
      {shownError && (
        <p className="notice notice-error" role="alert">
          {shownError}
        </p>
      )}
      <div className="billing-grid">
        <section className="card billing-budget" aria-labelledby="budget-title">
          <h3 id="budget-title">Spend limit</h3>
          {b ? (
            <>
              <p className="billing-remaining">
                <strong>{usd.format(b.spentUsd)}</strong> of {usd.format(b.monthlyUsd)} used in {monthLabel(b.month)}
                {b.remainingUsd >= 0 ? <> · {usd.format(b.remainingUsd)} left</> : <> · <span className="over">{usd.format(-b.remainingUsd)} over the limit</span></>}
              </p>
              <div className="budget-row">
                <div className={`budget-bar${share >= 1 ? " over" : share >= 0.8 ? " warn" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Share of the monthly spend limit used">
                  <span style={{ width: `${Math.min(100, share * 100)}%` }} />
                </div>
                <span className={`budget-pct${share >= 1 ? " over" : ""}`}>{pct}% used</span>
              </div>
              <p className="muted small">Resets {resetLabel(b.month)} (UTC). {b.basis === "anthropic" ? "Spend as billed by Anthropic." : "Spend by this assistant's own estimate; billed amounts need the Admin API key."}</p>
              {share >= 1 && (
                <p className="notice notice-error" role="alert">
                  The limit is reached: Anthropic refuses every request until the reset, unless the limit is raised in the Claude Console.
                </p>
              )}
            </>
          ) : (
            <p className="muted">No monthly spend limit recorded yet. Enter the limit set in the Claude Console (Billing, Spend limits) and this card shows how much of it is used.</p>
          )}
          <form className="billing-form" onSubmit={(e) => void saveBudget(e)}>
            <label>
              Monthly spend limit (USD)
              <input type="number" min={0} step="1" required value={budgetInput} onChange={(e) => setBudgetInput(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-primary" disabled={!budgetInput}>
              Save limit
            </button>
            {budgetSaved && (
              <span className="muted small" role="status">
                {budgetSaved}
              </span>
            )}
          </form>
          <p className="muted small">Keep it equal to the limit in the Claude Console; when that one is reached, every request is refused until the 1st.</p>
        </section>

        <section className="card billing-console" aria-labelledby="console-title">
          <h3 id="console-title">Claude Console</h3>
          <p className="muted">The credit balance, auto-reload, the spend limit itself and the invoices live in the Claude Console. Raise the limit there when the bar fills up.</p>
          <ul className="plain-list">
            <li>
              <a className="btn" href="https://console.anthropic.com/settings/billing" target="_blank" rel="noreferrer noopener">
                Billing: balance, auto-reload, spend limit
              </a>
            </li>
            <li>
              <a className="btn" href="https://console.anthropic.com/settings/usage" target="_blank" rel="noreferrer noopener">
                Usage: Anthropic's own report
              </a>
            </li>
          </ul>
          <p className="muted small">
            {report.anthropic.configured
              ? report.anthropic.error
                ? `Anthropic's cost report could not be read (${report.anthropic.error}); the figures here are this assistant's estimates.`
                : `Billed amounts from Anthropic's cost report${report.anthropic.fetchedAt ? `, read ${new Date(report.anthropic.fetchedAt).toLocaleString("en-US")}` : ""}.`
              : "To show the billed amounts here, the organization's Admin API key goes into AWS Secrets Manager (helixona-prod-anthropic-admin-key); until then the figures are this assistant's own estimates."}{" "}
            Counts and amounts only; no patient information.
          </p>
        </section>
      </div>
    </div>
  );
}

interface MonthlyProps {
  me: Me;
  report: BillingReport | null;
  error: string | null;
  userName: (id: string) => string;
}

/** Usage by month: a month picker, the period's totals and tables, and the months side by side underneath. */
export function MonthlyUsage({ me, report, error, userName }: MonthlyProps) {
  const [month, setMonth] = useState<string | null>(null);
  useEffect(() => {
    if (report) setMonth((m) => m ?? report.months[0]?.month ?? null);
  }, [report]);
  const shown = useMemo(() => (report ? report.months.filter((m, i) => i === 0 || m.turns > 0 || (report.anthropic.months[i]?.costUsd ?? 0) > 0) : []), [report]);
  const billed = useMemo(() => new Map((report?.anthropic.months ?? []).map((m) => [m.month, m.costUsd])), [report]);
  const hasBilled = !!report && report.anthropic.configured && !report.anthropic.error;
  const current = report?.months.find((m) => m.month === month) ?? null;
  const byModel = current ? Object.entries(current.byModel).sort((a, b) => b[1].estimatedUsd - a[1].estimatedUsd) : [];

  if (!report) return error ? <p className="notice notice-error" role="alert">{error}</p> : <p className="muted">Loading…</p>;
  return (
    <>
      <div className="period-row">
        <label htmlFor="billing-month" className="visually-hidden">
          Month
        </label>
        <select id="billing-month" value={month ?? ""} onChange={(e) => setMonth(e.target.value)}>
          {report.months.map((m) => (
            <option key={m.month} value={m.month}>
              {monthLabel(m.month)}
            </option>
          ))}
        </select>
      </div>
      {current && <UsageTables totals={current} byUser={current.byUser} byModel={byModel} models={me.catalog.models} userName={userName} periodLabel={monthLabel(current.month)} billedUsd={hasBilled ? (billed.get(current.month) ?? 0) : null} />}
      <h3 className="sub-title">Month by month</h3>
      <div className="table-wrap">
        <table className="billing-months">
          <thead>
            <tr>
              <th scope="col">Month</th>
              <th scope="col">Turns</th>
              <th scope="col">Input tokens</th>
              <th scope="col">Output tokens</th>
              <th scope="col">Estimated</th>
              {hasBilled && <th scope="col">Billed</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr key={m.month}>
                <td>{monthLabel(m.month)}</td>
                <td>{num.format(m.turns)}</td>
                <td>{num.format(m.inputTokens)}</td>
                <td>{num.format(m.outputTokens)}</td>
                <td>{usd.format(m.estimatedUsd)}</td>
                {hasBilled && <td>{usd.format(billed.get(m.month) ?? 0)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
