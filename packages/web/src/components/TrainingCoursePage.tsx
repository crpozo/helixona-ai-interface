import { useCallback, useEffect, useMemo, useState } from "react";
import { brand } from "../brand";
import { findDocument, type DocNode } from "../docs";
import { ApiError, getTraining, submitTrainingModule } from "../lib/api";
import type { Me, TrainingInfo, TrainingModuleResult, TrainingRecord } from "../lib/types";
import { DocNodes } from "./DocumentationPage";
import { Logo } from "./Logo";

interface Props {
  me: Me;
  /** Leaves the course (back to the assistant). */
  onExit: () => void;
}

type Step =
  | { kind: "module"; id: number; title: string; nodes: DocNode[] }
  | { kind: "reading"; key: string; title: string; nodes: DocNode[] }
  | { kind: "done"; title: string; nodes: DocNode[] };

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/** Splits the training document into its top-level sections, keyed by heading. */
function sections(): Map<string, DocNode[]> {
  const doc = findDocument("workforce-training");
  const out = new Map<string, DocNode[]>();
  if (!doc) return out;
  let current: DocNode[] | null = null;
  for (const n of doc.children) {
    if (n.type === "h" && n.level === 1) {
      current = [];
      out.set(n.text, current);
    } else if (current && n.type !== "pageBreak" && n.type !== "spacer") current.push(n);
  }
  return out;
}

function buildSteps(info: TrainingInfo, isAdmin: boolean): Step[] {
  const s = sections();
  const steps: Step[] = info.modules.map((m) => ({ kind: "module", id: m.id, title: m.title, nodes: s.get(m.title) ?? [] }));
  if (isAdmin) steps.push({ kind: "reading", key: "admins", title: "For administrators only", nodes: s.get("For administrators only") ?? [] });
  steps.push({ kind: "reading", key: "quick", title: "Quick reference", nodes: s.get("Quick reference") ?? [] });
  // Passing every module is the completion: there is nothing to sign, only the statement of what it means.
  steps.push({ kind: "done", title: "Training complete", nodes: s.get("What completing the training means") ?? [] });
  return steps;
}

function current(info: TrainingInfo): TrainingRecord | null {
  return info.record && info.record.version === info.version ? info.record : null;
}

function moduleDone(info: TrainingInfo, id: number): boolean {
  return !!current(info)?.moduleProgress?.[String(id)]?.completedAt;
}

/** The first step the user still has to do. */
function firstPending(info: TrainingInfo, steps: Step[]): number {
  const i = steps.findIndex((st) => st.kind === "module" && !moduleDone(info, st.id));
  return i >= 0 ? i : steps.length - 1;
}

/** The workforce training as a course: one module per screen, its questions right after, progress saved. */
export function TrainingCoursePage({ me, onExit }: Props) {
  const isAdmin = me.user.roles.includes("admin");
  const [info, setInfo] = useState<TrainingInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [phase, setPhase] = useState<"read" | "quiz">("read");
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [result, setResult] = useState<TrainingModuleResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const i = await getTraining();
      setInfo(i);
      setLoadError(null);
      return i;
    } catch (e) {
      setLoadError(errMsg(e));
      return null;
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    document.title = `Training · ${brand.productName}`;
    return () => {
      document.title = brand.productName;
    };
  }, []);

  const steps = useMemo(() => (info ? buildSteps(info, isAdmin) : []), [info, isAdmin]);
  useEffect(() => {
    if (info && index === null) setIndex(firstPending(info, steps));
  }, [info, index, steps]);
  useEffect(() => {
    if (import.meta.env.MODE !== "test") window.scrollTo(0, 0);
  }, [index, phase]);

  if (loadError) {
    return (
      <main className="center-screen">
        <p role="alert">{loadError}</p>
        <button type="button" className="btn btn-primary" onClick={() => void load()}>
          Retry
        </button>
      </main>
    );
  }
  if (!info || index === null) {
    return (
      <main className="center-screen" aria-busy="true">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const step = steps[index]!;
  const modules = steps.filter((s) => s.kind === "module");
  const doneModules = modules.filter((s) => s.kind === "module" && moduleDone(info, s.id)).length;
  const allDone = doneModules === modules.length;
  const record = current(info);
  const goTo = (i: number) => {
    setIndex(Math.max(0, Math.min(steps.length - 1, i)));
    setPhase("read");
    setAnswers({});
    setResult(null);
    setError(null);
  };
  const unlocked = (i: number) => {
    // Steps open in order; anything already completed stays open for review.
    const st = steps[i]!;
    if (st.kind === "module") return i === 0 || moduleDone(info, st.id) || moduleDone(info, (steps[i - 1] as { id: number }).id);
    return allDone;
  };

  const check = async () => {
    if (step.kind !== "module" || busy) return;
    const m = info.modules.find((x) => x.id === step.id)!;
    if (m.questions.some((n) => !answers[n])) return;
    setBusy(true);
    setError(null);
    try {
      const r = await submitTrainingModule(step.id, answers);
      setResult(r.result);
      setInfo((prev) => (prev ? { ...prev, record: r.record } : prev));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const questionsFor = (id: number) => {
    const m = info.modules.find((x) => x.id === id);
    return (m?.questions ?? []).map((n) => info.questions.find((q) => q.n === n)!).filter(Boolean);
  };

  return (
    <div className="course">
      <header className="login-bar docs-bar">
        <Logo variant="login" />
        <nav className="login-bar-right" aria-label="Course">
          <span className="login-bar-note">
            {doneModules} of {modules.length} modules
          </span>
          <a
            className="login-bar-link"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onExit();
            }}
          >
            Back to the assistant
          </a>
        </nav>
      </header>
      <div className="course-progress" aria-hidden="true">
        <span style={{ width: `${Math.round((doneModules / Math.max(1, modules.length)) * 100)}%` }} />
      </div>
      <div className="course-layout">
        <nav className="course-nav" aria-label="Course steps">
          <p className="eyebrow">Workforce training</p>
          <ol>
            {steps.map((st, i) => {
              const done = st.kind === "module" ? moduleDone(info, st.id) : st.kind === "done" ? !!record?.passedAt : allDone;
              const cls = ["course-step", i === index ? "current" : "", done ? "done" : "", unlocked(i) ? "" : "locked"].filter(Boolean).join(" ");
              return (
                <li key={i} className={cls}>
                  <button type="button" onClick={() => goTo(i)} disabled={!unlocked(i)} aria-current={i === index ? "step" : undefined}>
                    <span className="course-mark" aria-hidden="true">
                      {done ? "✓" : st.kind === "module" ? st.id : "•"}
                    </span>
                    <span>{st.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <main className="course-main">
          {step.kind === "module" && phase === "read" && (
            <article className="doc course-card">
              <p className="eyebrow">
                Module {step.id} of {modules.length}
              </p>
              <h1>{step.title.replace(/^Module \d+\.\s*/, "")}</h1>
              <DocNodes nodes={step.nodes} idPrefix={`m${step.id}`} />
              <div className="course-actions">
                {index > 0 && (
                  <button type="button" className="btn" onClick={() => goTo(index - 1)}>
                    Previous
                  </button>
                )}
                <button type="button" className="btn btn-primary" onClick={() => setPhase("quiz")}>
                  {moduleDone(info, step.id) ? "Review the questions" : "Continue to the questions"}
                </button>
              </div>
            </article>
          )}

          {step.kind === "module" && phase === "quiz" && (
            <article className="doc course-card">
              <p className="eyebrow">
                Module {step.id} of {modules.length}: check
              </p>
              <h1>Questions on {step.title.replace(/^Module \d+\.\s*/, "").toLowerCase()}</h1>
              <p className="muted small">Choose one answer per question. You can try again until every answer is right; your first attempt is what the training log records.</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void check();
                }}
              >
                {questionsFor(step.id).map((q, k) => {
                  const v = result?.results.find((x) => x.n === q.n);
                  return (
                    <fieldset key={q.n} className={`quiz-q${v ? (v.correct ? " correct" : " wrong") : ""}`} disabled={!!result || busy}>
                      <legend>
                        {k + 1}. {q.text}
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
                {error && (
                  <p className="notice notice-error" role="alert">
                    {error}
                  </p>
                )}
                <div className="course-actions">
                  <button type="button" className="btn" onClick={() => setPhase("read")} disabled={busy}>
                    Back to the module
                  </button>
                  {!result ? (
                    <button type="submit" className="btn btn-primary" disabled={busy || questionsFor(step.id).some((q) => !answers[q.n])}>
                      {busy ? "Checking…" : "Check answers"}
                    </button>
                  ) : result.moduleComplete ? (
                    <button type="button" className="btn btn-primary" onClick={() => goTo(index + 1)}>
                      {result.courseComplete ? "Continue" : "Next module"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        setResult(null);
                        setAnswers({});
                      }}
                    >
                      Try again
                    </button>
                  )}
                </div>
                {result && (
                  <p className="quiz-result" role="status">
                    <strong>
                      {result.correct} of {result.total} correct.
                    </strong>{" "}
                    {result.moduleComplete ? "Module complete." : "Review the module and try again."}
                  </p>
                )}
              </form>
            </article>
          )}

          {step.kind === "reading" && (
            <article className="doc course-card">
              <p className="eyebrow">Reading</p>
              <h1>{step.title}</h1>
              <DocNodes nodes={step.nodes} idPrefix={step.key} />
              <div className="course-actions">
                <button type="button" className="btn" onClick={() => goTo(index - 1)}>
                  Previous
                </button>
                <button type="button" className="btn btn-primary" onClick={() => goTo(index + 1)}>
                  Continue
                </button>
              </div>
            </article>
          )}

          {step.kind === "done" && (
            <article className="doc course-card course-done">
              <p className="eyebrow">Workforce training</p>
              <h1>Training complete</h1>
              <p>
                {me.user.name}, you completed the HIPAA training for the {brand.productName} on {record?.passedAt ? new Date(record.passedAt).toLocaleDateString("en-US", { dateStyle: "medium" }) : "today"}.
                {record ? ` First-attempt score: ${record.bestScore} of ${info.total}.` : ""} The completion is recorded in the training log with your name and email; there is nothing to sign.
              </p>
              <DocNodes nodes={step.nodes} idPrefix="done" />
              <p className="muted small">You can come back to any module from the list on the left at any time.</p>
              <div className="course-actions">
                <button type="button" className="btn btn-primary" onClick={onExit}>
                  Go to the assistant
                </button>
              </div>
            </article>
          )}
        </main>
      </div>
    </div>
  );
}
