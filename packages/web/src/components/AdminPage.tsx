import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminUser, Me, Role, UsageRow } from "../lib/types";
import { ApiError, adminCreateUser, adminDisableUser, adminEnableUser, adminListUsers, adminResendInvitation, adminResetMfa, adminSetRole, adminSetTemporaryPassword, adminUsage } from "../lib/api";
import { modelLabel } from "../lib/models";
import { TrainingLog } from "./TrainingSections";

interface Props {
  me: Me;
  onBack: () => void;
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("en-US");
const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

function errMsg(e: unknown): string {
  return e instanceof ApiError ? `Error (${e.code}).` : "Unexpected error.";
}

export function AdminPage({ me, onBack }: Props) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [form, setForm] = useState<{ email: string; name: string; role: Role }>({ email: "", name: "", role: "staff" });
  const [formBusy, setFormBusy] = useState(false);
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [day, setDay] = useState(todayIso());
  const [usage, setUsage] = useState<UsageRow[] | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setUsersError(null);
    try {
      setUsers(await adminListUsers());
    } catch (e) {
      setUsersError(errMsg(e));
    }
  }, []);

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
    void loadUsers();
  }, [loadUsers]);
  useEffect(() => {
    void loadUsage(day);
  }, [day, loadUsage]);

  const changeRole = async (u: AdminUser, role: Role) => {
    if (role === u.role) return;
    if (!window.confirm(`Change ${u.email} to ${role === "admin" ? "administrator" : "staff"}? They will be signed out and must sign in again.`)) return;
    setUsersError(null);
    try {
      await adminSetRole(u.id, role);
      setUsers((prev) => prev?.map((x) => (x.id === u.id ? { ...x, role } : x)) ?? prev);
    } catch (e) {
      setUsersError(errMsg(e));
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
      await loadUsers();
    } catch (err) {
      setFormMsg(errMsg(err));
    } finally {
      setFormBusy(false);
    }
  };

  const resetMfa = async (u: AdminUser) => {
    if (!window.confirm(`Reset the authenticator for ${u.email}? They will be signed out and asked to set up a new authenticator app at their next sign-in.`)) return;
    setUsersError(null);
    try {
      await adminResetMfa(u.id);
      setFormMsg(null);
      window.alert(`Authenticator reset for ${u.email}. Their next sign-in will show a new QR code.`);
    } catch (err) {
      setUsersError(errMsg(err));
    }
  };

  const resendInvitation = async (u: AdminUser) => {
    if (!window.confirm(`Send a new invitation to ${u.email}? It contains a new temporary password valid for 30 days.`)) return;
    setUsersError(null);
    try {
      await adminResendInvitation(u.id);
      window.alert(`Invitation sent again to ${u.email} from no-reply@verificationemail.com. Ask them to check the junk folder.`);
    } catch (err) {
      setUsersError(errMsg(err));
    }
  };

  const temporaryPassword = async (u: AdminUser) => {
    if (!window.confirm(`Set a new temporary password for ${u.email}? They will be signed out everywhere and must change it at their next sign-in. Hand it over in person or by phone, never by email or chat.`)) return;
    setUsersError(null);
    try {
      const r = await adminSetTemporaryPassword(u.id);
      // A prompt shows the password in a field the administrator can copy; it is not shown again.
      window.prompt(`Temporary password for ${u.email} (copy it now; it is not shown again):`, r.temporaryPassword);
      await loadUsers();
    } catch (err) {
      setUsersError(errMsg(err));
    }
  };

  const toggle = async (u: AdminUser) => {
    const action = u.enabled ? "disable" : "enable";
    if (!window.confirm(`Are you sure you want to ${action} ${u.name}?`)) return;
    try {
      if (u.enabled) await adminDisableUser(u.id);
      else await adminEnableUser(u.id);
      await loadUsers();
    } catch (err) {
      setUsersError(errMsg(err));
    }
  };

  const userName = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users ?? []) map.set(u.id, `${u.name} (${u.email})`);
    return (id: string) => map.get(id) ?? id;
  }, [users]);

  const byModel = useMemo(() => {
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

  const totals = useMemo(() => {
    const t = { turns: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0 };
    for (const r of usage ?? []) {
      t.turns += r.turns;
      t.inputTokens += r.inputTokens;
      t.outputTokens += r.outputTokens;
      t.estimatedUsd += r.estimatedUsd;
    }
    return t;
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

      <section aria-labelledby="users-title" className="card">
        <h2 id="users-title">Users</h2>
        {usersError && (
          <p className="notice notice-error" role="alert">
            {usersError}
          </p>
        )}
        {users === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td>
                      <select className="role-select" value={u.role} aria-label={`Role for ${u.email}`} disabled={u.id === me.user.id} onChange={(e) => void changeRole(u, e.target.value as Role)}>
                        <option value="staff">staff</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>{!u.enabled ? "Disabled" : u.status === "invited" ? "Invited (first sign-in pending)" : "Active"}</td>
                    <td>{dateFmt.format(new Date(u.createdAt))}</td>
                    <td>
                      <div className="row gap wrap">
                        {u.enabled && u.status === "invited" && (
                          <button type="button" className="btn btn-small" onClick={() => void resendInvitation(u)} title="New invitation email with a new temporary password (valid 30 days)">
                            Resend invitation
                          </button>
                        )}
                        <button type="button" className="btn btn-small" onClick={() => void toggle(u)} disabled={u.id === me.user.id}>
                          {u.enabled ? "Disable" : "Enable"}
                        </button>
                        <button type="button" className="btn btn-small" onClick={() => void resetMfa(u)} title="Lost or replaced phone: they enroll a new authenticator at the next sign-in">
                          Reset MFA
                        </button>
                        <button type="button" className="btn btn-small" onClick={() => void temporaryPassword(u)} disabled={u.id === me.user.id} title="Email never arrived: a new temporary password to hand over in person or by phone">
                          Temporary password
                        </button>
                      </div>
                    </td>
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

        <form className="admin-form" onSubmit={createUser}>
          <h3>Add a user</h3>
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
          <button type="submit" className="btn btn-primary" disabled={formBusy}>
            {formBusy ? "Creating…" : "Create user"}
          </button>
        </form>
      </section>

      <section aria-labelledby="training-title" className="card">
        <h2 id="training-title">Training log</h2>
        <p className="muted small">Knowledge-check results and acknowledgments completed online in the workforce training. Keep this log for six years; add paper completions by hand.</p>
        <TrainingLog />
      </section>

      <section aria-labelledby="usage-title" className="card">
        <div className="row gap wrap">
          <h2 id="usage-title">Daily usage</h2>
          <label htmlFor="usage-day" className="visually-hidden">
            Day
          </label>
          <input id="usage-day" type="date" value={day} max={todayIso()} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </div>
        {usageError && (
          <p className="notice notice-error" role="alert">
            {usageError}
          </p>
        )}
        {usage === null && !usageError ? (
          <p className="muted">Loading…</p>
        ) : usage && usage.length === 0 ? (
          <p className="muted">No activity on that day.</p>
        ) : usage ? (
          <>
            <p>
              Total: <strong>{num.format(totals.turns)}</strong> turns · {num.format(totals.inputTokens)} input tokens ·{" "}
              {num.format(totals.outputTokens)} output tokens · <strong>{usd.format(totals.estimatedUsd)}</strong> estimated
            </p>
            <h3>By user</h3>
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
                  {usage.map((r) => (
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
            <h3>By model</h3>
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
      </section>
    </main>
  );
}
