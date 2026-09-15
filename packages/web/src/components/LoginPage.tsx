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
      <header className="login-bar">
        <Logo variant="login" />
        <span className="login-bar-note">{brand.tagline}</span>
      </header>
      <section className="login-hero">
        <p className="eyebrow">Internal AI assistant</p>
        <h1 className="login-title">{brand.productName}</h1>
        <p className="login-sub">Private Claude workspace for the Helixona team: drafting, summaries, translations and patient-facing documents, with every conversation kept inside the clinic's own cloud.</p>
        {reason && (
          <p className="notice" role="status">
            {reason}
          </p>
        )}
        <a href="/api/auth/login" className="btn btn-primary btn-cta">
          Sign in
        </a>
        <p className="login-foot">Restricted to authorized staff. Sign in with your work account.</p>

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
      </section>
    </main>
  );
}
