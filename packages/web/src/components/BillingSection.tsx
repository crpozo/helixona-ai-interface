import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { BillingReport, Me } from "../lib/types";
import { ApiError, adminBilling, adminSetBudget, adminSetCredits } from "../lib/api";
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

/**
 * Budget and credits, for the administrators named in the server settings: the month so far against
 * the monthly budget, and the credits left: what was bought in the Claude Console, recorded here,
 * minus what was spent since.
 */
export function BudgetAndCredits({ report, error, reload }: BudgetProps) {
  const [form, setForm] = useState({ purchasedUsd: "", asOf: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [budgetInput, setBudgetInput] = useState("");
  const [budgetSaved, setBudgetSaved] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!report) return;
    if (report.credits) setForm({ purchasedUsd: String(report.credits.purchasedUsd), asOf: report.credits.asOf, note: report.credits.note });
    if (report.budget) setBudgetInput((v) => v || String(report.budget!.monthlyUsd));
  }, [report]);

  const saveBudget = async (e: FormEvent) => {
    e.preventDefault();
    setBudgetSaved(null);
    setLocalError(null);
    try {
      await adminSetBudget({ monthlyUsd: Number(budgetInput) });
      setBudgetSaved("Budget saved.");
      await reload();
    } catch (err) {
      setLocalError(errMsg(err));
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(null);
    setLocalError(null);
    try {
      await adminSetCredits({ purchasedUsd: Number(form.purchasedUsd), asOf: form.asOf, note: form.note });
      setSaved("Credits saved.");
      await reload();
    } catch (err) {
      setLocalError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const shownError = localError ?? error;
  if (!report) return shownError ? <p className="notice notice-error" role="alert">{shownError}</p> : <p className="muted">Loading…</p>;
  const b = report.budget;
  const share = b && b.monthlyUsd > 0 ? b.spentUsd / b.monthlyUsd : 0;
  return (
    <div className="billing">
      {shownError && (
        <p className="notice notice-error" role="alert">
          {shownError}
        </p>
      )}
      <div className="billing-grid">
        <section className="card billing-budget" aria-labelledby="budget-title">
          <h3 id="budget-title">This month</h3>
          {b ? (
            <>
              <p className="billing-remaining">
                <strong>{usd.format(b.spentUsd)}</strong> of {usd.format(b.monthlyUsd)} used in {monthLabel(b.month)}
                {b.remainingUsd >= 0 ? <> · {usd.format(b.remainingUsd)} left</> : <> · <span className="over">{usd.format(-b.remainingUsd)} over the budget</span></>}
              </p>
              <div className={`budget-bar${share >= 1 ? " over" : share >= 0.8 ? " warn" : ""}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(share * 100))} aria-label="Share of the monthly budget used">
                <span style={{ width: `${Math.min(100, share * 100)}%` }} />
              </div>
              <p className="muted small">{b.basis === "anthropic" ? "Billed by Anthropic this month." : "This assistant's own estimate for the month."} A guide, not a block: people keep working past it, and each person still has the $250 daily cap.</p>
            </>
          ) : (
            <p className="muted">No monthly budget set yet. Enter what the clinic plans to spend per month and this card shows how much of it is used.</p>
          )}
          <form className="billing-form" onSubmit={(e) => void saveBudget(e)}>
            <label>
              Monthly budget (USD)
              <input type="number" min={0} step="1" required value={budgetInput} onChange={(e) => setBudgetInput(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-primary" disabled={!budgetInput}>
              Save budget
            </button>
            {budgetSaved && (
              <span className="muted small" role="status">
                {budgetSaved}
              </span>
            )}
          </form>
        </section>

        <section className="card billing-credits" aria-labelledby="credits-title">
          <h3 id="credits-title">Credits</h3>
          {report.remaining && report.credits ? (
            <>
              <p className="billing-remaining">
                <strong>{usd.format(report.remaining.usd)}</strong> left, by this estimate
              </p>
              <p className="muted small">
                Bought {usd.format(report.credits.purchasedUsd)} as of {report.credits.asOf}
                {report.credits.note ? ` (${report.credits.note})` : ""}; spent since then {usd.format(report.remaining.spentUsd)} according to{" "}
                {report.remaining.basis === "anthropic" ? "Anthropic's cost report" : "this assistant's own estimate"}. The exact balance is in the Claude Console, under Plans & billing.
              </p>
            </>
          ) : (
            <p className="muted">No credits recorded yet. Enter what was bought in the Claude Console and the day it counts from.</p>
          )}
          <form className="billing-form" onSubmit={(e) => void save(e)}>
            <label>
              Credits purchased (USD)
              <input type="number" min={0} step="0.01" required value={form.purchasedUsd} onChange={(e) => setForm({ ...form, purchasedUsd: e.target.value })} disabled={saving} />
            </label>
            <label>
              As of
              <input type="date" required value={form.asOf} onChange={(e) => setForm({ ...form, asOf: e.target.value })} disabled={saving} />
            </label>
            <label>
              Note
              <input type="text" maxLength={200} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} disabled={saving} placeholder="Optional" />
            </label>
            <button type="submit" className="btn btn-primary" disabled={saving || !form.purchasedUsd || !form.asOf}>
              {saving ? "Saving…" : "Save credits"}
            </button>
            {saved && (
              <span className="muted small" role="status">
                {saved}
              </span>
            )}
          </form>
        </section>
      </div>
      <p className="muted small">
        {report.anthropic.configured
          ? report.anthropic.error
            ? `Anthropic's cost report could not be read (${report.anthropic.error}); the figures are this assistant's estimates.`
            : `Billed amounts from Anthropic's cost report${report.anthropic.fetchedAt ? `, read ${new Date(report.anthropic.fetchedAt).toLocaleString("en-US")}` : ""}.`
          : "Billed amounts need the organization's Admin API key in AWS Secrets Manager (helixona-prod-anthropic-admin-key); until then the figures are this assistant's own estimates."}{" "}
        Counts and amounts only; no patient information.
      </p>
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
