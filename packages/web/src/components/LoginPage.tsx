import { useState } from "react";
import type { Role } from "../lib/types";
import { ApiError, devLogin } from "../lib/api";
import { Logo } from "./Logo";
import { brand } from "../brand";

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
      setError(err instanceof ApiError ? `Could not sign in (${err.code}).` : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-card">
        <div className="login-logo"><Logo variant="login" /></div>
        <h1>{brand.productName}</h1>
        <p className="muted">Restricted to authorized staff. Sign in with your work account.</p>
        {reason && (
          <p className="notice" role="status">
            {reason}
          </p>
        )}
        <a href="/api/auth/login" className="btn btn-primary block">
          Sign in
        </a>

        {import.meta.env.DEV && (
          <form className="dev-login" onSubmit={submitDev}>
            <h2>Developer access</h2>
            <p className="muted small">Only available when the API is running with AUTH_MODE=dev.</p>
            <label htmlFor="dev-username">Username</label>
            <input id="dev-username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" />
            <label htmlFor="dev-role">Role</label>
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
              {busy ? "Signing in…" : "Sign in (dev)"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
