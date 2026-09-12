import { useCallback, useEffect, useMemo, useState } from "react";
import type { AdminUser, Me, Role, UsageRow } from "../lib/types";
import { ApiError, adminCreateUser, adminDisableUser, adminEnableUser, adminListUsers, adminUsage } from "../lib/api";
import { modelLabel } from "../lib/models";

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

const usd = new Intl.NumberFormat("es", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("es");
const dateFmt = new Intl.DateTimeFormat("es", { dateStyle: "medium" });

function errMsg(e: unknown): string {
  return e instanceof ApiError ? `Error (${e.code}).` : "Error inesperado.";
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

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormBusy(true);
    setFormMsg(null);
    try {
      await adminCreateUser({ email: form.email.trim(), name: form.name.trim(), role: form.role });
      setForm({ email: "", name: "", role: "staff" });
      setFormMsg("Usuario creado. Recibirá una contraseña temporal por correo.");
      await loadUsers();
    } catch (err) {
      setFormMsg(errMsg(err));
    } finally {
      setFormBusy(false);
    }
  };

  const toggle = async (u: AdminUser) => {
    const action = u.enabled ? "deshabilitar" : "habilitar";
    if (!window.confirm(`¿Seguro que quieres ${action} a ${u.name}?`)) return;
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
        <h1>Administración</h1>
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
            Volver al chat
          </a>
        </div>
      </header>

      <section aria-labelledby="users-title" className="card">
        <h2 id="users-title">Usuarios</h2>
        {usersError && (
          <p className="notice notice-error" role="alert">
            {usersError}
          </p>
        )}
        {users === null ? (
          <p className="muted">Cargando…</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Nombre</th>
                  <th scope="col">Correo</th>
                  <th scope="col">Rol</th>
                  <th scope="col">Estado</th>
                  <th scope="col">Alta</th>
                  <th scope="col">
                    <span className="visually-hidden">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td>{u.role}</td>
                    <td>{u.enabled ? "Activo" : "Deshabilitado"}</td>
                    <td>{dateFmt.format(new Date(u.createdAt))}</td>
                    <td>
                      <button type="button" className="btn btn-small" onClick={() => void toggle(u)} disabled={u.id === me.user.id}>
                        {u.enabled ? "Deshabilitar" : "Habilitar"}
                      </button>
                    </td>
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No hay usuarios.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <form className="admin-form" onSubmit={createUser}>
          <h3>Dar de alta un usuario</h3>
          <div className="form-grid">
            <div>
              <label htmlFor="nu-name">Nombre</label>
              <input id="nu-name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="nu-email">Correo corporativo</label>
              <input id="nu-email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label htmlFor="nu-role">Rol</label>
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
            {formBusy ? "Creando…" : "Crear usuario"}
          </button>
        </form>
      </section>

      <section aria-labelledby="usage-title" className="card">
        <div className="row gap wrap">
          <h2 id="usage-title">Uso del día</h2>
          <label htmlFor="usage-day" className="visually-hidden">
            Día
          </label>
          <input id="usage-day" type="date" value={day} max={todayIso()} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </div>
        {usageError && (
          <p className="notice notice-error" role="alert">
            {usageError}
          </p>
        )}
        {usage === null && !usageError ? (
          <p className="muted">Cargando…</p>
        ) : usage && usage.length === 0 ? (
          <p className="muted">Sin actividad ese día.</p>
        ) : usage ? (
          <>
            <p>
              Total: <strong>{num.format(totals.turns)}</strong> turnos · {num.format(totals.inputTokens)} tokens de entrada ·{" "}
              {num.format(totals.outputTokens)} de salida · <strong>{usd.format(totals.estimatedUsd)}</strong> estimados
            </p>
            <h3>Por usuario</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Usuario</th>
                    <th scope="col">Turnos</th>
                    <th scope="col">Entrada</th>
                    <th scope="col">Salida</th>
                    <th scope="col">Costo est.</th>
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
            <h3>Por modelo</h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Modelo</th>
                    <th scope="col">Turnos</th>
                    <th scope="col">Costo est.</th>
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
