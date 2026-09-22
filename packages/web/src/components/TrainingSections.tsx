import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, acknowledgeTraining, adminTraining, getTraining, submitTrainingCheck } from "../lib/api";
import type { AdminTrainingRow, Me, TrainingCheckResult, TrainingInfo, TrainingRecord } from "../lib/types";

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const when = (iso: string) => dateFmt.format(new Date(iso));

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

// The check and the acknowledgment are separate sections of the document; when one changes the
// record, the other reloads.
const listeners = new Set<() => void>();
function notifyRecordChanged() {
  for (const l of listeners) l();
}

function useTraining(): { info: TrainingInfo | null; error: string | null; reload: () => Promise<void>; setRecord: (r: TrainingRecord) => void } {
  const [info, setInfo] = useState<TrainingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setInfo(await getTraining());
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void reload();
    listeners.add(reload);
    return () => {
      listeners.delete(reload);
    };
  }, [reload]);
  const setRecord = useCallback((record: TrainingRecord) => setInfo((prev) => (prev ? { ...prev, record } : prev)), []);
  return { info, error, reload, setRecord };
}

/** One line on where the signed-in user stands. */
export function TrainingStatus({ info }: { info: TrainingInfo }) {
  const r = info.record;
  if (!r) return <p className="training-status">Not started. Answer the questions below; your score is saved to the training log.</p>;
  if (r.acknowledgedAt) {
    return (
      <p className="training-status passed">
        Completed. Passed on {when(r.passedAt ?? r.lastAttemptAt)} with {r.bestScore} of {info.total}; acknowledgment signed on {when(r.acknowledgedAt)}.
      </p>
    );
  }
  if (r.passedAt) {
    return (
      <p className="training-status passed">
        Passed on {when(r.passedAt)} with {r.bestScore} of {info.total}. Sign the acknowledgment at the end of this document to finish.
      </p>
    );
  }
  return (
    <p className="training-status">
      Last attempt on {when(r.lastAttemptAt)}: {r.lastScore} of {info.total}. Passing score is {info.passingScore}. Review the modules and try again.
    </p>
  );
}

/** The knowledge check, answered online. Replaces the paper version of the section for signed-in staff. */
export function TrainingCheck({ me }: { me: Me }) {
  const { info, error, setRecord } = useTraining();
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [result, setResult] = useState<TrainingCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  if (error) {
    return (
      <p className="notice notice-error" role="alert">
        {error}
      </p>
    );
  }
  if (!info) return <p className="muted">Loading…</p>;

  const complete = info.questions.every((q) => answers[q.n]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!complete || busy) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const r = await submitTrainingCheck(info.questions.map((q) => answers[q.n] ?? ""));
      setResult(r.result);
      setRecord(r.record);
      notifyRecordChanged();
    } catch (err) {
      setSubmitError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const retry = () => {
    setResult(null);
    setAnswers({});
  };
  const verdict = (n: number) => result?.results.find((x) => x.n === n);

  return (
    <div className="training-check">
      <p className="muted small">
        Signed in as {me.user.name}. Choose one answer per question. Passing score: {info.passingScore} of {info.total}.
      </p>
      <TrainingStatus info={info} />
      <form onSubmit={submit}>
        {info.questions.map((q) => {
          const v = verdict(q.n);
          return (
            <fieldset key={q.n} className={`quiz-q${v ? (v.correct ? " correct" : " wrong") : ""}`} disabled={!!result || busy}>
              <legend>
                {q.n}. {q.text}
              </legend>
              {q.options.map((o) => (
                <label key={o.letter} className="quiz-opt">
                  <input type="radio" name={`q${q.n}`} value={o.letter} checked={answers[q.n] === o.letter} onChange={() => setAnswers((a) => ({ ...a, [q.n]: o.letter }))} />
                  <span>
                    <strong>{o.letter}.</strong> {o.text}
                  </span>
                </label>
              ))}
              {v && (
                <p className={`quiz-verdict ${v.correct ? "ok" : "ko"}`} role="status">
                  {v.correct ? "Correct." : `Not quite. ${v.why ?? ""}`}
                </p>
              )}
            </fieldset>
          );
        })}
        {submitError && (
          <p className="notice notice-error" role="alert">
            {submitError}
          </p>
        )}
        {result ? (
          <div className="quiz-result" role="status">
            <strong>
              Score: {result.score} of {result.total}. {result.passed ? "Passed." : `Not passed (${info.passingScore} needed).`}
            </strong>
            <p className="muted small">{result.passed ? "Your result is saved. Sign the acknowledgment at the end of this document." : "Your attempt is saved. Review the modules above and try again."}</p>
            <button type="button" className="btn" onClick={retry}>
              {result.passed ? "Take it again" : "Try again"}
            </button>
          </div>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!complete || busy}>
            {busy ? "Checking…" : "Submit answers"}
          </button>
        )}
      </form>
    </div>
  );
}

/** The acknowledgment, signed online once the check is passed. `children` is the document's statement list. */
export function TrainingAcknowledgment({ me, children }: { me: Me; children: ReactNode }) {
  const { info, error, setRecord } = useTraining();
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  const sign = async () => {
    if (!accepted || busy) return;
    setBusy(true);
    setSignError(null);
    try {
      const r = await acknowledgeTraining();
      setRecord(r.record);
      notifyRecordChanged();
    } catch (err) {
      setSignError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const record = info?.record ?? null;
  return (
    <div className="training-ack">
      {children}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {info && record?.acknowledgedAt ? (
        <p className="training-status passed" role="status">
          Signed by {record.name || me.user.name} ({record.email || me.user.email}) on {when(record.acknowledgedAt)}. Recorded in the training log.
        </p>
      ) : info ? (
        <div className="ack-form">
          {!record?.passedAt && <p className="muted small">Pass the knowledge check above to enable the signature.</p>}
          <label className="quiz-opt">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} disabled={!record?.passedAt || busy} />
            <span>
              I, {me.user.name} ({me.user.email}), confirm the statements above.
            </span>
          </label>
          {signError && (
            <p className="notice notice-error" role="alert">
              {signError}
            </p>
          )}
          <button type="button" className="btn btn-primary" disabled={!accepted || !record?.passedAt || busy} onClick={() => void sign()}>
            {busy ? "Signing…" : "Sign acknowledgment"}
          </button>
          <p className="muted small">Your name, email and the date are recorded; this replaces the paper signature.</p>
        </div>
      ) : (
        <p className="muted">Loading…</p>
      )}
    </div>
  );
}

function status(row: AdminTrainingRow): string {
  const r = row.record;
  if (!r) return "Not started";
  if (r.acknowledgedAt) return "Completed";
  if (r.passedAt) return "Passed, acknowledgment pending";
  return "In progress";
}

/** The training log (administrators): one row per user. */
export function TrainingLog() {
  const [rows, setRows] = useState<AdminTrainingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setRows(await adminTraining());
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <p className="notice notice-error" role="alert">
        {error}
      </p>
    );
  }
  if (!rows) return <p className="muted">Loading…</p>;
  return (
    <div className="table-wrap">
      <table className="training-log">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
            <th scope="col">Attempts</th>
            <th scope="col">Best score</th>
            <th scope="col">Passed</th>
            <th scope="col">Acknowledged</th>
            <th scope="col">Version</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td>{row.email}</td>
              <td>{row.role}{row.enabled ? "" : " (disabled)"}</td>
              <td>{status(row)}</td>
              <td>{row.record?.attempts ?? 0}</td>
              <td>{row.record ? row.record.bestScore : "–"}</td>
              <td>{row.record?.passedAt ? when(row.record.passedAt) : "–"}</td>
              <td>{row.record?.acknowledgedAt ? when(row.record.acknowledgedAt) : "–"}</td>
              <td>{row.record?.version ?? "–"}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="muted">
                No users.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
