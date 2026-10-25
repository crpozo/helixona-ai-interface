import type { CatalogModel } from "../lib/types";
import { modelLabel } from "../lib/models";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("en-US");

export interface UsageByUser { userId: string; turns: number; inputTokens: number; outputTokens: number; estimatedUsd: number }
export interface UsageTotals { turns: number; inputTokens: number; outputTokens: number; estimatedUsd: number }

interface Props {
  totals: UsageTotals;
  byUser: UsageByUser[];
  byModel: Array<[string, { turns: number; estimatedUsd: number }]>;
  models: CatalogModel[];
  userName: (id: string) => string;
  /** What the period is called in the totals line ("today", "Oct 2026"). */
  periodLabel: string;
  /** The billed amount for the period, when Anthropic's cost report is configured. */
  billedUsd?: number | null;
}

/** The usage of a period, the same way for a day and for a month: totals, then by user and by model side by side. */
export function UsageTables({ totals, byUser, byModel, models, userName, periodLabel, billedUsd }: Props) {
  if (totals.turns === 0) return <p className="muted">No activity in {periodLabel}.</p>;
  return (
    <>
      <div className="stat-row" aria-label={`Totals for ${periodLabel}`}>
        <div className="stat">
          <span className="stat-value">{usd.format(totals.estimatedUsd)}</span>
          <span className="stat-label">estimated</span>
        </div>
        {billedUsd != null && (
          <div className="stat">
            <span className="stat-value">{usd.format(billedUsd)}</span>
            <span className="stat-label">billed</span>
          </div>
        )}
        <div className="stat">
          <span className="stat-value">{num.format(totals.turns)}</span>
          <span className="stat-label">turns</span>
        </div>
        <div className="stat">
          <span className="stat-value">{num.format(totals.inputTokens)}</span>
          <span className="stat-label">input tokens</span>
        </div>
        <div className="stat">
          <span className="stat-value">{num.format(totals.outputTokens)}</span>
          <span className="stat-label">output tokens</span>
        </div>
      </div>
      <div className="usage-grid">
        <div className="table-wrap usage-by-user">
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
              {[...byUser].sort((a, b) => b.estimatedUsd - a.estimatedUsd).map((r) => (
                <tr key={r.userId}>
                  <td>{userName(r.userId)}</td>
                  <td>{num.format(r.turns)}</td>
                  <td>{num.format(r.inputTokens)}</td>
                  <td>{num.format(r.outputTokens)}</td>
                  <td>{usd.format(r.estimatedUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="table-wrap usage-by-model">
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
                  <td title={model}>{modelLabel(models, model)}</td>
                  <td>{num.format(v.turns)}</td>
                  <td>{usd.format(v.estimatedUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
