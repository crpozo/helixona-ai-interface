import { useCallback, useEffect, useState } from "react";
import { ApiError, adminFeedbackStatus, adminResendFeedbackConfirmation, adminSendTestBugReport } from "../lib/api";
import type { FeedbackStatus } from "../lib/types";

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/**
 * Administration card: where the sidebar's bug reports go and whether that inbox has confirmed its
 * subscription (SNS delivers nothing until the link in its confirmation email is clicked).
 */
export function FeedbackDelivery() {
  const [status, setStatus] = useState<FeedbackStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await adminFeedbackStatus());
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await action();
      setInfo(done);
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !status) {
    return (
      <p className="notice notice-error" role="alert">
        {error}
      </p>
    );
  }
  if (!status) return <p className="muted">Loading…</p>;

  const email = status.email;
  const line = !status.enabled
    ? "Bug reports are not enabled on this server."
    : !email
      ? "No recipient is configured for bug reports (the feedbackEmail setting of the infrastructure)."
      : status.subscription === "confirmed"
        ? `Reports from the sidebar are emailed to ${email}. Delivery confirmed.`
        : status.subscription === "pending"
          ? `${email} has not confirmed its subscription yet, so nothing is delivered. SNS sent that inbox an email titled "AWS Notification - Subscription Confirmation" from no-reply@sns.amazonaws.com (check the junk folder); the link in it must be clicked once.`
          : status.subscription === "none"
            ? `${email} is not subscribed to the reports yet. Request the confirmation email and click the link in it.`
            : "The subscription status could not be read right now.";
  const needsConfirmation = status.enabled && !!email && (status.subscription === "pending" || status.subscription === "none");

  return (
    <div className="feedback-delivery">
      <p className={status.subscription === "confirmed" || !status.enabled ? "muted small" : "notice"} role={needsConfirmation ? "status" : undefined}>
        {line}
      </p>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {info && (
        <p className="notice" role="status">
          {info}
        </p>
      )}
      {status.enabled && email && (
        <div className="row gap wrap">
          {needsConfirmation && (
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(adminResendFeedbackConfirmation, `Confirmation email requested for ${email}. Click the link in it, then send a test.`)}>
              {status.subscription === "none" ? "Subscribe and send the confirmation email" : "Resend the confirmation email"}
            </button>
          )}
          <button type="button" className="btn" disabled={busy} onClick={() => void run(adminSendTestBugReport, `Test report sent. It should reach ${email} within a minute once the subscription is confirmed.`)}>
            Send a test report
          </button>
        </div>
      )}
    </div>
  );
}
