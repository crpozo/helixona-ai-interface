import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import type { BillingReport, Me } from "../lib/types";
import { ApiError, adminBilling, adminSetCredits } from "../lib/api";
import { modelLabel } from "../lib/models";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("en-US");
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Please try again.");

/** "2026-10" → "Oct 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

interface Props {
  me: Me;
  userName: (id: string) => string;
}

/**
 * The billing view, for the administrators named in the server settings: what each month cost
 * (the assistant's own estimate, and the billed amount when the organization's Admin API key is
 * configured), by user and by model, and the credits left: what was bought in the Claude Console,
 * recorded here, minus what was spent since.
 */
export function BillingSection({ me, userName }: Props) {
  const [report, setReport] = useState<BillingReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [form, setForm] = useState({ purchasedUsd: "", asOf: "", note: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await adminBilling();
      setReport(r);
      setMonth((m) => m ?? r.months[0]?.month ?? null);
      if (r.credits) setForm({ purchasedUsd: String(r.credits.purchasedUsd), asOf: r.credits.asOf, note: r.credits.note });
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(null);
    try {
      await adminSetCredits({ purchasedUsd: Number(form.purchasedUsd), asOf: form.asOf, note: form.note });
      setSaved("Credits saved.");
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  const shown = useMemo(() => (report ? report.months.filter((m, i) => i === 0 || m.turns > 0 || (report.anthropic.months[i]?.costUsd ?? 0) > 0) : []), [report]);
  const billed = useMemo(() => new Map((report?.anthropic.months ?? []).map((m) => [m.month, m.costUsd])), [report]);
  const current = report?.months.find((m) => m.month === month) ?? null;
  const byModel = current ? Object.entries(current.byModel).sort((a, b) => b[1].estimatedUsd - a[1].estimatedUsd) : [];

  return (
    <section aria-labelledby="billing-title" className="card billing">
      <h2 id="billing-title">Usage by month and credits</h2>
      <p className="muted small">Shown only to the administrators named in the server settings. Counts and amounts only; no patient information.</p>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {report === null && !error ? (
        <p className="muted">Loading…</p>
      ) : report ? (
        <>
          <div className="billing-credits">
            <h3>Credits</h3>
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
            <p className="muted small">
              {report.anthropic.configured
                ? report.anthropic.error
                  ? `Anthropic's cost report could not be read (${report.anthropic.error}); the figures below are this assistant's estimates.`
                  : `Billed amounts from Anthropic's cost report${report.anthropic.fetchedAt ? `, read ${new Date(report.anthropic.fetchedAt).toLocaleString("en-US")}` : ""}.`
                : "Billed amounts need the organization's Admin API key in AWS Secrets Manager (helixona-prod-anthropic-admin-key); until then the figures are this assistant's own estimates."}
            </p>
          </div>

          <h3>By month</h3>
          <div className="table-wrap">
            <table className="billing-months">
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col">Turns</th>
                  <th scope="col">Input tokens</th>
                  <th scope="col">Output tokens</th>
                  <th scope="col">Estimated</th>
                  {report.anthropic.configured && !report.anthropic.error && <th scope="col">Billed</th>}
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
                    {report.anthropic.configured && !report.anthropic.error && <td>{usd.format(billed.get(m.month) ?? 0)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row gap wrap">
            <h3>Detail</h3>
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
          {current && current.turns === 0 ? (
            <p className="muted">No activity in {monthLabel(current.month)}.</p>
          ) : current ? (
            <>
              <h4>By user</h4>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">User</th>
                      <th scope="col">Turns</th>
                      <th scope="col">Input</th>
                      <th scope="col">Output</th>
                      <th scope="col">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.byUser.map((u) => (
                      <tr key={u.userId}>
                        <td>{userName(u.userId)}</td>
                        <td>{num.format(u.turns)}</td>
                        <td>{num.format(u.inputTokens)}</td>
                        <td>{num.format(u.outputTokens)}</td>
                        <td>{usd.format(u.estimatedUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h4>By model</h4>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Model</th>
                      <th scope="col">Turns</th>
                      <th scope="col">Est. cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byModel.map(([model, v]) => (
                      <tr key={model}>
                        <td title={model}>{modelLabel(me.catalog.models, model)}</td>
                        <td>{num.format(v.turns)}</td>
                        <td>{usd.format(v.estimatedUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
