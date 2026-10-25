import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminTrainingLog, AdminTrainingRow, AdminUser, AuditEvent, Me, Role, UsageRow } from "../lib/types";
import { ApiError, adminAudit, adminCreateUser, adminDisableUser, adminEnableUser, adminListUsers, adminRecordPaperTraining, adminResendInvitation, adminResetMfa, adminSetRole, adminSetTemporaryPassword, adminTraining, adminUsage } from "../lib/api";
import { modelLabel } from "../lib/models";
import { trainingStatus } from "./TrainingSections";
import { FeedbackDelivery } from "./FeedbackDelivery";
import { BudgetAndCredits, MonthlyUsage, useBillingReport } from "./BillingSection";
import { UsageTables } from "./UsageTables";
import { RowMenu, type RowMenuItem } from "./RowMenu";

interface Props {
  me: Me;
  onBack: () => void;
}

type Tab = "users" | "usage" | "billing" | "system";

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const timeFmt = new Intl.DateTimeFormat("en-US", { timeStyle: "short" });

function errMsg(e: unknown): string {
  return e instanceof ApiError ? `Error (${e.code}).` : "Unexpected error.";
}

/** The administration page: Users (with their training), Usage (a day or a month), Billing (budget and credits) and System. */
export function AdminPage({ me, onBack }: Props) {
  const tabs = useMemo<Array<{ id: Tab; label: string }>>(
    () => [{ id: "users", label: "Users" }, { id: "usage", label: "Usage" }, ...(me.billing ? [{ id: "billing" as const, label: "Billing" }] : []), { id: "system", label: "System" }],
    [me.billing],
  );
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const t = sessionStorage.getItem("hx.admin.tab") as Tab | null;
      return t && ["users", "usage", "billing", "system"].includes(t) ? t : "users";
    } catch {
      return "users";
    }
  });
  const pick = (t: Tab) => {
    setTab(t);
    try { sessionStorage.setItem("hx.admin.tab", t); } catch { /* private window */ }
  };
  const shownTab = tabs.some((t) => t.id === tab) ? tab : "users";

  // ---- Users and their training
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [training, setTraining] = useState<AdminTrainingLog | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const loadUsers = useCallback(async () => {
    setUsersError(null);
    try {
      const [u, t] = await Promise.all([adminListUsers(), adminTraining().catch(() => null)]);
      setUsers(u);
      setTraining(t);
    } catch (e) {
      setUsersError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const userName = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users ?? []) map.set(u.id, `${u.name} (${u.email})`);
    return (id: string) => map.get(id) ?? id;
  }, [users]);

  // ---- Usage by day
  const [day, setDay] = useState(todayIso());
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const loadUsage = useCallback(async (d: string) => {
    setUsageError(null);
    setUsage(null);
    try {
      setUsage(await adminUsage(d));
    } catch (e) {
      setUsageError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void loadUsage(day);
  }, [day, loadUsage]);
  const [period, setPeriod] = useState<"day" | "month">("day");
  const billing = useBillingReport(!!me.billing);

  const dayTotals = useMemo(() => {
    const t = { turns: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
    for (const r of usage ?? []) {
      t.turns += r.turns;
      t.inputTokens += r.inputTokens;
      t.outputTokens += r.outputTokens;
      t.estimatedUsd += r.estimatedUsd;
    }
    return t;
  }, [usage]);
  const dayByModel = useMemo(() => {
    const acc = new Map<string, { turns: number; estimatedUsd: number }>();
    for (const row of usage ?? []) {
      for (const [model, v] of Object.entries(row.byModel ?? {})) {
        const cur = acc.get(model) ?? { turns: 0, estimatedUsd: 0 };
        cur.turns += v.turns;
        cur.estimatedUsd += v.estimatedUsd;
        acc.set(model, cur);
      }
    }
    return [...acc.entries()].sort((a, b) => b[1].estimatedUsd - a[1].estimatedUsd);
  }, [usage]);

  return (
    <main className="admin">
      <header className="admin-head">
        <h1>Administration</h1>
        <div className="row gap">
          <span className="muted small">{me.user.name}</span>
          <a
            href="/"
            className="btn"
            onClick={(e) => {
              e.preventDefault();
              onBack();
            }}
          >
            Back to chat
          </a>
        </div>
      </header>

      <div className="tabs" role="tablist" aria-label="Administration sections">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={shownTab === t.id} aria-controls={`panel-${t.id}`} className={`tab${shownTab === t.id ? " active" : ""}`} onClick={() => pick(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {shownTab === "users" && (
        <section id="panel-users" role="tabpanel" aria-labelledby="tab-users" className="tab-panel">
          <UsersPanel me={me} users={users} training={training} error={usersError} setError={setUsersError} reload={loadUsers} setUsers={setUsers} />
        </section>
      )}

      {shownTab === "usage" && (
        <section id="panel-usage" role="tabpanel" aria-labelledby="tab-usage" className="tab-panel card">
          <div className="period-row">
            {me.billing && (
              <div className="seg" role="group" aria-label="Period">
                <button type="button" className={period === "day" ? "active" : ""} aria-pressed={period === "day"} onClick={() => setPeriod("day")}>
                  Day
                </button>
                <button type="button" className={period === "month" ? "active" : ""} aria-pressed={period === "month"} onClick={() => setPeriod("month")}>
                  Month
                </button>
              </div>
            )}
            {period === "day" && (
              <>
                <label htmlFor="usage-day" className="visually-hidden">
                  Day
                </label>
                <input id="usage-day" type="date" value={day} max={todayIso()} onChange={(e) => e.target.value && setDay(e.target.value)} />
              </>
            )}
          </div>
          {period === "day" ? (
            usageError ? (
              <p className="notice notice-error" role="alert">
                {usageError}
              </p>
            ) : usage === null ? (
              <p className="muted">Loading…</p>
            ) : (
              <UsageTables totals={dayTotals} byUser={usage} byModel={dayByModel} models={me.catalog.models} userName={userName} periodLabel={day === todayIso() ? "today" : dateFmt.format(new Date(`${day}T12:00:00`))} />
            )
          ) : (
            <MonthlyUsage me={me} report={billing.report} error={billing.error} userName={userName} />
          )}
        </section>
      )}

      {shownTab === "billing" && me.billing && (
        <section id="panel-billing" role="tabpanel" aria-labelledby="tab-billing" className="tab-panel">
          <BudgetAndCredits report={billing.report} error={billing.error} reload={billing.reload} />
        </section>
      )}

      {shownTab === "system" && (
        <section id="panel-system" role="tabpanel" aria-labelledby="tab-system" className="tab-panel">
          <section className="card" aria-labelledby="feedback-title">
            <h3 id="feedback-title">Bug reports</h3>
            <FeedbackDelivery />
          </section>
          <ModelErrors me={me} userName={userName} />
        </section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------- Users

interface UsersPanelProps {
  me: Me;
  users: AdminUser[] | null;
  training: AdminTrainingLog | null;
  error: string | null;
  setError: (s: string | null) => void;
  reload: () => Promise<void>;
  setUsers: React.Dispatch<React.SetStateAction<AdminUser[] | null>>;
}

function UsersPanel({ me, users, training, error, setError, reload, setUsers }: UsersPanelProps) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ email: string; name: string; role: Role }>({ email: "", name: "", role: "staff" });
  const [formBusy, setFormBusy] = useState(false);
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const trainingById = useMemo(() => new Map((training?.items ?? []).map((r) => [r.id, r])), [training]);
  const gone = useMemo(() => (training?.items ?? []).filter((r) => !r.inDirectory), [training]);

  const changeRole = async (u: AdminUser, role: Role) => {
    if (role === u.role) return;
    if (!window.confirm(`Change ${u.email} to ${role === "admin" ? "administrator" : "staff"}? They will be signed out and must sign in again.`)) return;
    setError(null);
    try {
      await adminSetRole(u.id, role);
      setUsers((prev) => prev?.map((x) => (x.id === u.id ? { ...x, role } : x)) ?? prev);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormBusy(true);
    setFormMsg(null);
    try {
      await adminCreateUser({ email: form.email.trim(), name: form.name.trim(), role: form.role });
      setForm({ email: "", name: "", role: "staff" });
      setFormMsg("User created. They will receive a temporary password by email.");
      await reload();
    } catch (err) {
      setFormMsg(errMsg(err));
    } finally {
      setFormBusy(false);
    }
  };

  const resetMfa = async (u: AdminUser) => {
    if (!window.confirm(`Reset the authenticator for ${u.email}? They will be signed out and asked to set up a new authenticator app at their next sign-in.`)) return;
    setError(null);
    try {
      await adminResetMfa(u.id);
      window.alert(`Authenticator reset for ${u.email}. Their next sign-in will show a new QR code.`);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const resendInvitation = async (u: AdminUser) => {
    if (!window.confirm(`Send a new invitation to ${u.email}? It contains a new temporary password valid for 30 days.`)) return;
    setError(null);
    try {
      await adminResendInvitation(u.id);
      window.alert(`Invitation sent again to ${u.email} from no-reply@verificationemail.com. Ask them to check the junk folder.`);
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const temporaryPassword = async (u: AdminUser) => {
    if (!window.confirm(`Set a new temporary password for ${u.email}? They will be signed out everywhere and must change it at their next sign-in. Hand it over in person or by phone, never by email or chat.`)) return;
    setError(null);
    try {
      const r = await adminSetTemporaryPassword(u.id);
      // A prompt shows the password in a field the administrator can copy; it is not shown again.
      window.prompt(`Temporary password for ${u.email} (copy it now; it is not shown again):`, r.temporaryPassword);
      await reload();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const toggle = async (u: AdminUser) => {
    const action = u.enabled ? "disable" : "enable";
    if (!window.confirm(`Are you sure you want to ${action} ${u.name}?`)) return;
    try {
      if (u.enabled) await adminDisableUser(u.id);
      else await adminEnableUser(u.id);
      await reload();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const recordPaper = async (row: AdminTrainingRow) => {
    if (!training) return;
    const date = window.prompt(`Date ${row.name} completed the training on paper (YYYY-MM-DD):`, todayIso());
    if (!date) return;
    const scoreText = window.prompt(`Score on the paper knowledge check (${training.passingScore} of ${training.total} or better):`, String(training.total));
    if (scoreText === null) return;
    const score = Number(scoreText);
    if (!Number.isInteger(score)) return setError("The score must be a whole number.");
    try {
      await adminRecordPaperTraining(row.id, { completedAt: date.trim(), score });
      await reload();
    } catch (e) {
      // The server says what was wrong with the paper record (a score below the passing mark, a date in the future).
      setError(e instanceof ApiError ? e.message : errMsg(e));
    }
  };

  const complete = (r: AdminTrainingRow | undefined) => !!training && !!r?.record && r.record.version === training.version && !!r.record.passedAt;

  const trainingCell = (u: AdminUser) => {
    const row = trainingById.get(u.id);
    if (!training) return <span className="muted">–</span>;
    if (!row) return <span className="muted">Not started</span>;
    const s = trainingStatus(row, training.version);
    const rec = row.record;
    // Attested completions have no score; online and paper ones show the best score and the date.
    const detail = rec && rec.passedAt ? (rec.source === "attested" ? dateFmt.format(new Date(rec.passedAt)) : `${rec.bestScore}/${training.total} · ${dateFmt.format(new Date(rec.passedAt))}`) : rec && rec.attempts > 0 ? `${rec.attempts} ${rec.attempts === 1 ? "attempt" : "attempts"} · best ${rec.bestScore}/${training.total}` : null;
    return (
      <>
        <span className={complete(row) ? "ok" : s === "Not started" ? "muted" : "warn"}>{s}</span>
        {detail && <span className="cell-sub">{detail}</span>}
      </>
    );
  };

  const menuFor = (u: AdminUser): RowMenuItem[] => {
    const row = trainingById.get(u.id);
    const items: RowMenuItem[] = [];
    if (u.enabled && u.status === "invited") items.push({ label: "Resend invitation", icon: "download", onSelect: () => void resendInvitation(u) });
    items.push({ label: "Reset MFA", icon: "gear", onSelect: () => void resetMfa(u) });
    if (u.id !== me.user.id) items.push({ label: "Temporary password", icon: "pencil", onSelect: () => void temporaryPassword(u) });
    if (training && u.enabled && !complete(row)) items.push({ label: "Record paper completion", icon: "cap", onSelect: () => void recordPaper(row ?? { id: u.id, name: u.name, email: u.email, role: u.role, enabled: u.enabled, inDirectory: true, record: null }) });
    return items;
  };

  return (
    <>
      <div className="card">
        <div className="tab-head">
          <p className="muted small">
            {users ? `${users.length} ${users.length === 1 ? "account" : "accounts"}` : ""}
            {training ? ` · training version ${training.version}, passing score ${training.passingScore} of ${training.total}; a person without a completed training cannot use the assistant` : ""}
          </p>
          <button type="button" className="btn btn-primary btn-small" aria-expanded={adding} aria-controls="add-user" onClick={() => setAdding((v) => !v)}>
            Add a user
          </button>
        </div>
        {adding && (
          <form id="add-user" className="admin-form" onSubmit={createUser}>
            <div className="form-grid">
              <div>
                <label htmlFor="nu-name">Name</label>
                <input id="nu-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <label htmlFor="nu-email">Work email</label>
                <input id="nu-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div>
                <label htmlFor="nu-role">Role</label>
                <select id="nu-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                  <option value="staff">staff</option>
                  <option value="admin">admin</option>
                </select>
              </div>
            </div>
            {formMsg && (
              <p className="notice" role="status">
                {formMsg}
              </p>
            )}
            <div className="row gap">
              <button type="submit" className="btn btn-primary" disabled={formBusy}>
                {formBusy ? "Creating…" : "Create user"}
              </button>
              <button type="button" className="btn" onClick={() => setAdding(false)}>
                Close
              </button>
            </div>
          </form>
        )}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {users === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="table-wrap">
            <table className="users-table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Training</th>
                  <th scope="col">Since</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <span>{u.name}</span>
                      <span className="cell-sub">{u.email}</span>
                    </td>
                    <td>
                      <select className="role-select" value={u.role} aria-label={`Role for ${u.email}`} disabled={u.id === me.user.id} onChange={(e) => void changeRole(u, e.target.value as Role)}>
                        <option value="staff">staff</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>{!u.enabled ? <span className="warn">Disabled</span> : u.status === "invited" ? <span className="muted">Invited</span> : "Active"}</td>
                    <td>{trainingCell(u)}</td>
                    <td className="muted">{dateFmt.format(new Date(u.createdAt))}</td>
                    <td>
                      <div className="row gap">
                        <button type="button" className="btn btn-small" onClick={() => void toggle(u)} disabled={u.id === me.user.id}>
                          {u.enabled ? "Disable" : "Enable"}
                        </button>
                        <RowMenu name={u.email} items={menuFor(u)} />
                      </div>
                    </td>
                  </tr>
                ))}
                {gone.map((r) => (
                  <tr key={`gone-${r.id}`} className="muted">
                    <td>
                      <span>{r.name}</span>
                      <span className="cell-sub">{r.email} · no longer in the directory</span>
                    </td>
                    <td>{r.role}</td>
                    <td>Removed</td>
                    <td>{training ? trainingStatus(r, training.version) : "–"}</td>
                    <td>–</td>
                    <td />
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No users.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- System: failed turns

/** The turns that failed on a day, with the reason the server recorded, so an administrator sees at once whether the provider, the account or the configuration is the problem. */
function ModelErrors({ me, userName }: { me: Me; userName: (id: string) => string }) {
  const [day, setDay] = useState(todayIso());
  const [items, setItems] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    adminAudit(day, "turn_error", 200)
      .then((r) => {
        if (!cancelled) setItems([...r].reverse());
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errMsg(e));
      });
    return () => {
      cancelled = true;
    };
  }, [day]);
  const kindLabel = (k: unknown) =>
    k === "billing" ? "Provider account out of credit" : k === "config" ? "Configuration" : k === "availability" ? "Provider unavailable or rate-limited" : k === "auth" ? "API key rejected" : k === "bug" ? "Request rejected" : k === "aborted" ? "Cancelled" : String(k ?? "unknown");
  return (
    <section className="card" aria-labelledby="errors-title">
      <div className="tab-head">
        <h3 id="errors-title">Failed turns</h3>
        <div className="row gap">
          <label htmlFor="errors-day" className="visually-hidden">
            Day
          </label>
          <input id="errors-day" type="date" value={day} max={todayIso()} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </div>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : items === null ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">No failed turns that day.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">User</th>
                <th scope="col">Model</th>
                <th scope="col">Reason</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{timeFmt.format(new Date(i.ts))}</td>
                  <td>{userName(i.userId)}</td>
                  <td>{i.model ? modelLabel(me.catalog.models, i.model) : "–"}</td>
                  <td>{kindLabel(i.meta?.kind)}</td>
                  <td className="muted">{String(i.meta?.errorClass ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
