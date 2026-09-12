import { useState } from "react";
import type { Role } from "../lib/types";
import { ApiError, devLogin } from "../lib/api";

interface Props {
  onDevLoggedIn: () => void;
  reason?: string | null;
}

export function LoginPage({ onDevLoggedIn, reason }: Props) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitDev = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await devLogin(username.trim(), role);
      onDevLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? `No se pudo iniciar sesión (${err.code}).` : "No se pudo iniciar sesión.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-card">
        <h1>Asistente de la clínica</h1>
        <p className="muted">Acceso exclusivo para personal autorizado. Inicia sesión con tu cuenta corporativa.</p>
        {reason && (
          <p className="notice" role="status">
            {reason}
          </p>
        )}
        <a href="/api/auth/login" className="btn btn-primary block">
          Iniciar sesión
        </a>

        {import.meta.env.DEV && (
          <form className="dev-login" onSubmit={submitDev}>
            <h2>Acceso de desarrollo</h2>
            <p className="muted small">Solo disponible cuando la API corre con AUTH_MODE=dev.</p>
            <label htmlFor="dev-username">Usuario</label>
            <input id="dev-username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" />
            <label htmlFor="dev-role">Rol</label>
            <select id="dev-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="staff">staff</option>
              <option value="admin">admin</option>
            </select>
            {error && (
              <p className="notice notice-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="btn" disabled={busy || !username.trim()}>
              {busy ? "Entrando…" : "Entrar (dev)"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
