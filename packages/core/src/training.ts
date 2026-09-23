import { TRAINING_MODULES, TRAINING_PASSING_SCORE, TRAINING_QUIZ, TRAINING_VERSION } from "./training-quiz.generated.js";

/**
 * Workforce training knowledge check. The questions come from the training document
 * (tools/hipaa-docs/content/training.js); the API grades the answers server-side so the answer
 * key never reaches the browser of a staff member taking the check. Each question belongs to one
 * module, which lets the in-app course ask them module by module.
 */
const LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

export interface TrainingQuestion {
  n: number;
  module: number;
  text: string;
  options: { letter: string; text: string }[];
}

export interface TrainingModule {
  id: number;
  title: string;
  /** Question numbers (1-based) asked at the end of this module. */
  questions: number[];
}

export interface TrainingCheckResult {
  score: number;
  total: number;
  passed: boolean;
  /** One entry per question; `why` is included for wrong answers only. */
  results: { n: number; correct: boolean; why?: string }[];
}

const questions: TrainingQuestion[] = TRAINING_QUIZ.map((q, i) => ({
  n: i + 1,
  module: q.module,
  text: q.text,
  options: q.options.map((text, k) => ({ letter: LETTERS[k] ?? String(k + 1), text })),
}));

export const TRAINING_INFO: { version: string; passingScore: number; total: number; questions: TrainingQuestion[]; modules: TrainingModule[] } = {
  version: TRAINING_VERSION,
  passingScore: TRAINING_PASSING_SCORE,
  total: TRAINING_QUIZ.length,
  questions,
  modules: TRAINING_MODULES.map((m) => ({ id: m.id, title: m.title, questions: questions.filter((q) => q.module === m.id).map((q) => q.n) })),
};

function grade(n: number, answer: string | undefined): { n: number; correct: boolean; why?: string } {
  const q = TRAINING_QUIZ[n - 1]!;
  const correct = (answer ?? "").trim().toUpperCase() === q.answer;
  return correct ? { n, correct } : { n, correct, why: q.why };
}

/** Grades one answer per question (letters, in order); null when the number of answers is wrong. */
export function gradeTraining(answers: readonly string[]): TrainingCheckResult | null {
  if (answers.length !== TRAINING_QUIZ.length) return null;
  const results = answers.map((a, i) => grade(i + 1, a));
  const score = results.filter((r) => r.correct).length;
  return { score, total: TRAINING_QUIZ.length, passed: score >= TRAINING_PASSING_SCORE, results };
}

/** Grades the questions of one module (answers keyed by question number); null for an unknown module or a missing answer. */
export function gradeModule(moduleId: number, answers: Readonly<Record<string, string>>): { results: { n: number; correct: boolean; why?: string }[]; correct: number; total: number; allCorrect: boolean } | null {
  const module = TRAINING_INFO.modules.find((m) => m.id === moduleId);
  if (!module) return null;
  if (module.questions.some((n) => !answers[String(n)])) return null;
  const results = module.questions.map((n) => grade(n, answers[String(n)]));
  const correct = results.filter((r) => r.correct).length;
  return { results, correct, total: results.length, allCorrect: correct === results.length };
}
