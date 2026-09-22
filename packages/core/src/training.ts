import { TRAINING_PASSING_SCORE, TRAINING_QUIZ, TRAINING_VERSION } from "./training-quiz.generated.js";

/**
 * Workforce training knowledge check. The questions come from the training document
 * (tools/hipaa-docs/content/training.js); the API grades the answers server-side so the answer
 * key never reaches the browser of a staff member taking the check.
 */
const LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

export interface TrainingQuestion {
  n: number;
  text: string;
  options: { letter: string; text: string }[];
}

export interface TrainingCheckResult {
  score: number;
  total: number;
  passed: boolean;
  /** One entry per question; `why` is included for wrong answers only. */
  results: { n: number; correct: boolean; why?: string }[];
}

export const TRAINING_INFO: { version: string; passingScore: number; total: number; questions: TrainingQuestion[] } = {
  version: TRAINING_VERSION,
  passingScore: TRAINING_PASSING_SCORE,
  total: TRAINING_QUIZ.length,
  questions: TRAINING_QUIZ.map((q, i) => ({
    n: i + 1,
    text: q.text,
    options: q.options.map((text, k) => ({ letter: LETTERS[k] ?? String(k + 1), text })),
  })),
};

/** Grades one answer per question (letters); null when the number of answers is wrong. */
export function gradeTraining(answers: readonly string[]): TrainingCheckResult | null {
  if (answers.length !== TRAINING_QUIZ.length) return null;
  const results = TRAINING_QUIZ.map((q, i) => {
    const correct = (answers[i] ?? "").trim().toUpperCase() === q.answer;
    return correct ? { n: i + 1, correct } : { n: i + 1, correct, why: q.why };
  });
  const score = results.filter((r) => r.correct).length;
  return { score, total: TRAINING_QUIZ.length, passed: score >= TRAINING_PASSING_SCORE, results };
}
