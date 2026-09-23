import { useEffect, useRef, useState } from "react";
import { ApiError, reportBug } from "../lib/api";
import { Icon } from "./Icon";

const MIN = 10;
const MAX = 2000;

/**
 * "Report a bug" in the sidebar: a row that opens a small text box; the description goes by email
 * to the person who runs the assistant. Nothing is stored in the app beyond an audit entry.
 */
export function BugReport() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const trimmed = text.trim();

  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => {
      setSent(false);
      setOpen(false);
    }, 4000);
    return () => clearTimeout(t);
  }, [sent]);

  const submit = async () => {
    if (busy || trimmed.length < MIN) return;
    setBusy(true);
    setError(null);
    try {
      await reportBug(trimmed, window.location.pathname);
      setText("");
      setSent(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The report could not be sent. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`bug-report${open ? " open" : ""}`}>
      <button type="button" className="side-link" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="bug-report-form">
        <Icon name="bug" />
        <span>Report a bug</span>
      </button>
      {open && (
        <form
          id="bug-report-form"
          className="bug-report-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {sent ? (
            <p className="bug-report-sent" role="status">
              Sent. Thank you!
            </p>
          ) : (
            <>
              <label htmlFor="bug-report-text" className="visually-hidden">
                Describe the problem
              </label>
              <textarea
                id="bug-report-text"
                ref={ref}
                rows={4}
                maxLength={MAX}
                value={text}
                placeholder="What happened, and what did you expect? Please do not include patient information."
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                }}
                disabled={busy}
              />
              {error && (
                <p className="notice notice-error" role="alert">
                  {error}
                </p>
              )}
              <div className="bug-report-actions">
                <button type="submit" className="btn btn-primary btn-small" disabled={busy || trimmed.length < MIN}>
                  {busy ? "Sending…" : "Send"}
                </button>
                <button type="button" className="btn btn-small" onClick={() => setOpen(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </form>
      )}
    </div>
  );
}
