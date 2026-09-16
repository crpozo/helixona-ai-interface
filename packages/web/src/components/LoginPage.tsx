import { useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import type { Role } from "../lib/types";
import { ApiError, devLogin, forgotPassword, passwordChallenge, passwordSignIn, resetPassword, type PasswordResult } from "../lib/api";
import { Logo } from "./Logo";
import { brand } from "../brand";
import { navigate } from "../lib/router";

interface Props {
  onSignedIn: () => void;
  reason?: string | null;
}

function openDocs(e: React.MouseEvent) {
  e.preventDefault();
  navigate("/documentation");
}

type Step =
  | { kind: "signin" }
  | { kind: "new-password"; session: string }
  | { kind: "mfa"; session: string }
  | { kind: "mfa-setup"; session: string; secret: string; otpauthUrl: string }
  | { kind: "forgot" }
  | { kind: "reset" };

const PASSWORD_HINT = "At least 12 characters with upper and lower case letters, a number and a symbol.";

/** QR code as inline SVG (white tile so phone cameras read it on the dark theme). */
function QrCode({ value, label }: { value: string; label: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [value]);
  return <div className="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Password input with a show/hide toggle; it stays a real password field for password managers. */
function PasswordInput({ id, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { id: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="pw-field">
      <input id={id} {...props} type={shown ? "text" : "password"} />
      <button type="button" className="pw-toggle" onClick={() => setShown((s) => !s)} aria-pressed={shown} aria-controls={id} aria-label={shown ? "Hide password" : "Show password"} disabled={props.disabled}>
        {shown ? "Hide" : "Show"}
      </button>
    </div>
  );
}

/** Manual-entry key in groups of four, easier to type from a screen. */
function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export function LoginPage({ onSignedIn, reason }: Props) {
  const [step, setStep] = useState<Step>({ kind: "signin" });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [devUser, setDevUser] = useState("");
  const [devRole, setDevRole] = useState<Role>("staff");
  const [devAvailable, setDevAvailable] = useState(import.meta.env.DEV);

  const go = (next: Step) => {
    setStep(next);
    setError(null);
    setInfo(null);
    setCode("");
    setNewPassword("");
    setConfirm("");
  };

  const handleResult = (r: PasswordResult) => {
    if ("ok" in r) {
      onSignedIn();
      return;
    }
    if (r.challenge === "NEW_PASSWORD_REQUIRED") {
      go({ kind: "new-password", session: r.session });
      setInfo("Your temporary password must be replaced before you continue.");
    } else if (r.challenge === "MFA_SETUP") {
      go({ kind: "mfa-setup", session: r.session, secret: r.secret, otpauthUrl: r.otpauthUrl });
    } else {
      go({ kind: "mfa", session: r.session });
    }
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && e.code === "not_found") {
        setDevAvailable(true);
        setError("Password sign-in is not enabled on this server.");
      } else {
        setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  const submitSignIn = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => handleResult(await passwordSignIn(email.trim(), password)));
  };
  const submitNewPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (step.kind !== "new-password") return;
    if (newPassword !== confirm) return setError("The passwords do not match.");
    const session = step.session;
    void run(async () => handleResult(await passwordChallenge({ email: email.trim(), session, challenge: "NEW_PASSWORD_REQUIRED", newPassword })));
  };
  const submitMfa = (e: React.FormEvent) => {
    e.preventDefault();
    if (step.kind !== "mfa") return;
    const session = step.session;
    void run(async () => handleResult(await passwordChallenge({ email: email.trim(), session, challenge: "MFA", code: code.trim() })));
  };
  const submitMfaSetup = (e: React.FormEvent) => {
    e.preventDefault();
    if (step.kind !== "mfa-setup") return;
    const session = step.session;
    void run(async () => handleResult(await passwordChallenge({ email: email.trim(), session, challenge: "MFA_SETUP", code: code.trim() })));
  };
  const submitForgot = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await forgotPassword(email.trim());
      go({ kind: "reset" });
      setInfo("If that address has an account, a reset code is on its way. Enter it below with your new password.");
    });
  };
  const submitReset = (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirm) return setError("The passwords do not match.");
    void run(async () => {
      await resetPassword(email.trim(), code.trim(), newPassword);
      go({ kind: "signin" });
      setInfo("Password updated. Sign in with your new password.");
      setPassword("");
    });
  };
  const submitDev = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await devLogin(devUser.trim(), devRole);
      onSignedIn();
    });
  };

  const emailField = (
    <>
      <label htmlFor="login-email">Work email</label>
      <input id="login-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
    </>
  );
  const newPasswordFields = (
    <>
      <label htmlFor="login-new">New password</label>
      <PasswordInput id="login-new" autoComplete="new-password" required minLength={12} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={busy} aria-describedby="login-hint" />
      <label htmlFor="login-confirm">Confirm new password</label>
      <PasswordInput id="login-confirm" autoComplete="new-password" required minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
      <p id="login-hint" className="login-hint">{PASSWORD_HINT}</p>
    </>
  );

  return (
    <main className="login">
      <header className="login-bar">
        <Logo variant="login" />
        <nav className="login-bar-right" aria-label="Site">
          <span className="login-bar-note">{brand.tagline}</span>
          <a className="login-bar-link" href="/documentation" onClick={openDocs}>
            Documentation
          </a>
        </nav>
      </header>
      <section className="login-hero">
        <div className="login-copy">
          <p className="eyebrow">Internal AI assistant</p>
          <h1 className="login-title">{brand.productName}</h1>
          <p className="login-sub">Private Claude workspace for the Helixona team: drafting, summaries, translations and document analysis, with every conversation and file kept inside the clinic's own cloud.</p>
          <p className="login-foot">Restricted to authorized staff. Sign-in requires a password and an authenticator app; activity is logged for security and HIPAA compliance.</p>
          <p className="login-foot">
            <a href="/documentation" onClick={openDocs}>
              HIPAA documentation
            </a>
            : risk analysis, policies and procedures, and workforce training.
          </p>
        </div>

        <div className="login-panel" aria-live="polite">
          {step.kind === "signin" && (
            <form onSubmit={submitSignIn}>
              <h2>Sign in</h2>
              {reason && <p className="notice" role="status">{reason}</p>}
              {info && <p className="notice" role="status">{info}</p>}
              {emailField}
              <label htmlFor="login-password">Password</label>
              <PasswordInput id="login-password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
              {error && <p className="notice notice-error" role="alert">{error}</p>}
              <button type="submit" className="btn btn-primary btn-cta block" disabled={busy || !email || !password}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
              <div className="login-links">
                <button type="button" className="link" onClick={() => go({ kind: "forgot" })}>Forgot your password?</button>
              </div>
            </form>
          )}

          {step.kind === "new-password" && (
            <form onSubmit={submitNewPassword}>
              <h2>Choose a new password</h2>
              {info && <p className="notice" role="status">{info}</p>}
              {newPasswordFields}
              {error && <p className="notice notice-error" role="alert">{error}</p>}
              <button type="submit" className="btn btn-primary btn-cta block" disabled={busy || !newPassword || !confirm}>
                {busy ? "Saving…" : "Save and continue"}
              </button>
              <div className="login-links">
                <button type="button" className="link" onClick={() => go({ kind: "signin" })}>Back to sign in</button>
              </div>
            </form>
          )}

          {step.kind === "mfa" && (
            <form onSubmit={submitMfa}>
              <h2>Authenticator code</h2>
              <p className="muted small">Enter the 6-digit code from your authenticator app.</p>
              <label htmlFor="login-code">Code</label>
              <input id="login-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
              {error && <p className="notice notice-error" role="alert">{error}</p>}
              <button type="submit" className="btn btn-primary btn-cta block" disabled={busy || code.trim().length < 6}>
                {busy ? "Checking…" : "Continue"}
              </button>
              <div className="login-links">
                <button type="button" className="link" onClick={() => go({ kind: "signin" })}>Back to sign in</button>
              </div>
            </form>
          )}

          {step.kind === "mfa-setup" && (
            <form onSubmit={submitMfaSetup}>
              <h2>Set up your authenticator</h2>
              <p className="muted small">
                Your account requires a second step at sign-in. Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password or Authy), scan this code, then enter the 6-digit code it shows.
              </p>
              <QrCode value={step.otpauthUrl} label="QR code for your authenticator app" />
              <details className="login-manual">
                <summary>Can't scan? Enter the key manually</summary>
                <p className="secret-key" aria-label="Setup key">{groupSecret(step.secret)}</p>
                <p className="muted small">Choose "time-based" if the app asks.</p>
              </details>
              <label htmlFor="login-setup-code">Code from the app</label>
              <input id="login-setup-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
              {error && <p className="notice notice-error" role="alert">{error}</p>}
              <button type="submit" className="btn btn-primary btn-cta block" disabled={busy || code.trim().length < 6}>
                {busy ? "Verifying…" : "Finish setup"}
              </button>
              <div className="login-links">
                <button type="button" className="link" onClick={() => go({ kind: "signin" })}>Back to sign in</button>
              </div>
            </form>
          )}

          {step.kind === "forgot" && (
            <form onSubmit={submitForgot}>
              <h2>Reset your password</h2>
              <p className="muted small">We'll email you a code to choose a new password.</p>
              {emailField}
              {error && <p className="notice notice-error" role="alert">{error}</p>}
              <button type="submit" className="btn btn-primary btn-cta block" disabled={busy || !email}>
                {busy ? "Sending…" : "Send code"}
              </button>
              <div className="login-links">
                <button type="button" className="link" onClick={() => go({ kind: "signin" })}>Back to sign in</button>
                <button type="button" className="link" onClick={() => go({ kind: "reset" })}>I already have a code</button>
              </div>
            </form>
          )}

          {step.kind === "reset" && (
            <form onSubmit={submitReset}>
              <h2>Enter your code</h2>
              {info && <p className="notice" role="status">{info}</p>}
              {emailField}
              <label htmlFor="login-reset-code">Code from the email</label>
              <input id="login-reset-code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} />
              {newPasswordFields}
              {error && <p className="notice notice-error" role="alert">{error}</p>}
              <button type="submit" className="btn btn-primary btn-cta block" disabled={busy || !email || !code || !newPassword || !confirm}>
                {busy ? "Saving…" : "Set new password"}
              </button>
              <div className="login-links">
                <button type="button" className="link" onClick={() => go({ kind: "signin" })}>Back to sign in</button>
              </div>
            </form>
          )}

          {devAvailable && (
            <form className="dev-login" onSubmit={submitDev}>
              <h2>Developer access</h2>
              <p className="muted small">Only available when the API is running with AUTH_MODE=dev.</p>
              <label htmlFor="dev-username">Username</label>
              <input id="dev-username" value={devUser} onChange={(e) => setDevUser(e.target.value)} required autoComplete="off" />
              <label htmlFor="dev-role">Role</label>
              <select id="dev-role" value={devRole} onChange={(e) => setDevRole(e.target.value as Role)}>
                <option value="staff">staff</option>
                <option value="admin">admin</option>
              </select>
              <button type="submit" className="btn" disabled={busy || !devUser.trim()}>
                {busy ? "Signing in…" : "Sign in (dev)"}
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
