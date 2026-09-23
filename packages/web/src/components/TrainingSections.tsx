import { useCallback, useEffect, useState } from "react";
import { ApiError, adminRecordPaperTraining, adminTraining, attestTraining, getTraining, submitTrainingCheck } from "../lib/api";
import { navigate } from "../lib/router";
import type { AdminTrainingLog, AdminTrainingRow, Me, TrainingCheckResult, TrainingInfo, TrainingRecord } from "../lib/types";

const dateFmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });
const when = (iso: string) => dateFmt.format(new Date(iso));

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
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
  }, [reload]);
  const setRecord = useCallback((record: TrainingRecord) => setInfo((prev) => (prev ? { ...prev, record } : prev)), []);
  return { info, error, reload, setRecord };
}

/** The record counts only for the current version of the training. */
function current(info: TrainingInfo): TrainingRecord | null {
  return info.record && info.record.version === info.version ? info.record : null;
}

/** One line on where the signed-in user stands. Passing the check is the completion; nothing is signed. */
export function TrainingStatus({ info }: { info: TrainingInfo }) {
  const r = current(info);
  if (!r) {
    return (
      <p className="training-status">
        {info.record ? `Your previous completion was for version ${info.record.version}; this is version ${info.version}. ` : "Not started. "}
        Answer the questions below; your score is saved to the training log.
      </p>
    );
  }
  if (r.passedAt && r.source === "attested") {
    return (
      <p className="training-status passed">
        Training skipped on {when(r.passedAt)}: you attested that you already know this material. You can still take the check below; a passed check replaces the attestation in the log.
      </p>
    );
  }
  if (r.passedAt) {
    return (
      <p className="training-status passed">
        Completed. Passed on {when(r.passedAt)} with {r.bestScore} of {info.total}
        {r.source === "paper" ? " (recorded from the paper check)" : ""}. Nothing to sign: the completion is in the training log.
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
            <p className="muted small">
              {result.passed
                ? `Your result is saved and the training is complete${me.training?.required ? "; the assistant is unlocked" : ""}. There is nothing to sign.`
                : "Your attempt is saved. Review the modules above and try again."}
            </p>
            <button type="button" className="btn" onClick={retry}>
              {result.passed ? "Take it again" : "Reset answers and try again"}
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

/** Shown in place of the chat until the signed-in user (administrators included) completes the training. */
export function TrainingGate({ me, onRefresh }: { me: Me; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const skip = async () => {
    if (
      !window.confirm(
        "Skip the online training?\n\nBy continuing you attest that you have already completed the clinic's HIPAA training for the Helixona Assistant (on paper or in a previous session) and that you know its contents: minimum necessary patient information, reviewing every output, using no other AI tool for patient information, keeping your password and authenticator private, and reporting incidents within one hour.\n\nYour name, email and the date are recorded in the training log as an attestation.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await attestTraining();
      onRefresh();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel-center">
      <div className="training-gate">
        <p className="eyebrow">Workforce training</p>
        <h1>Hello, {me.user.name}. One step before you start.</h1>
        <p className="training-gate-lead">
          Every user of the assistant, administrators included, completes the HIPAA training first. Seven short modules, each followed by a few
          questions. About 25 minutes, nothing to sign, and your progress is saved as you go.
        </p>
        <div className="training-gate-actions">
          <a
            className="btn btn-primary btn-large"
            href="/training"
            onClick={(e) => {
              e.preventDefault();
              navigate("/training");
            }}
          >
            Start the training
          </a>
          <button type="button" className="btn btn-large" onClick={onRefresh} disabled={busy}>
            I have completed it
          </button>
        </div>
        {me.training?.canSkip && (
          <p className="training-skip">
            <button type="button" className="link" onClick={() => void skip()} disabled={busy}>
              {busy ? "Recording…" : "Skip training, I already know this"}
            </button>
          </p>
        )}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        <p className="muted small training-gate-note">Completed it on paper? Ask an administrator to record it in the training log.</p>
      </div>
    </div>
  );
}

function status(row: AdminTrainingRow, version: string): string {
  const r = row.record;
  if (!r) return "Not started";
  if (r.version !== version) return `Outdated (version ${r.version})`;
  if (r.passedAt) return r.source === "paper" ? "Completed (paper)" : r.source === "attested" ? "Skipped (attested by user)" : "Completed";
  return "In progress";
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The training log (administrators): one row per user, with a way to record paper completions. `refreshKey` reloads it when the users change. */
export function TrainingLog({ refreshKey = 0 }: { refreshKey?: number } = {}) {
  const [log, setLog] = useState<AdminTrainingLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setLog(await adminTraining());
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const recordPaper = async (row: AdminTrainingRow) => {
    if (!log) return;
    const date = window.prompt(`Date ${row.name} completed the training on paper (YYYY-MM-DD):`, todayIso());
    if (!date) return;
    const scoreText = window.prompt(`Score on the paper knowledge check (${log.passingScore} of ${log.total} or better):`, String(log.total));
    if (scoreText === null) return;
    const score = Number(scoreText);
    if (!Number.isInteger(score)) return setError("The score must be a whole number.");
    try {
      await adminRecordPaperTraining(row.id, { completedAt: date.trim(), score });
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  if (error && !log) {
    return (
      <p className="notice notice-error" role="alert">
        {error}
      </p>
    );
  }
  if (!log) return <p className="muted">Loading…</p>;
  const complete = (r: TrainingRecord | null) => !!r && r.version === log.version && !!r.passedAt;
  return (
    <div className="table-wrap">
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <p className="muted small">Training version {log.version}. Passing score {log.passingScore} of {log.total}. Users without a completed row cannot use the assistant.</p>
      <table className="training-log">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
            <th scope="col">Attempts</th>
            <th scope="col">Best score</th>
            <th scope="col">Completed</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {log.items.map((row) => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td>{row.email}</td>
              <td>
                {row.role}
                {row.enabled ? "" : " (disabled)"}
              </td>
              <td>{status(row, log.version)}</td>
              <td>{row.record?.attempts ?? 0}</td>
              <td>{row.record ? row.record.bestScore : "–"}</td>
              <td>{row.record?.passedAt ? when(row.record.passedAt) : "–"}</td>
              <td>
                {!complete(row.record) && row.enabled && (
                  <button type="button" className="btn btn-small" onClick={() => void recordPaper(row)} title="The paper knowledge check is on file">
                    Record paper completion
                  </button>
                )}
              </td>
            </tr>
          ))}
          {log.items.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                No users.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
