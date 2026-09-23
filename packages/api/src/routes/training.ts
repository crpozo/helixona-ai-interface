import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { TRAINING_INFO, gradeModule, gradeTraining } from "@helixona/core";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth } from "../app.js";
import type { TrainingModuleProgress, TrainingRecord } from "../repos/types.js";

/** What the browser sees: the record without the raw answers. */
function publicRecord(r: TrainingRecord | null) {
  if (!r) return null;
  const { answers: _answers, ...rest } = r;
  return rest;
}

/** Passed the check (online, on paper, or by attestation) for the current version of the training. Nothing is signed. */
export function trainingComplete(r: TrainingRecord | null): boolean {
  return !!r && !!r.passedAt && r.version === TRAINING_INFO.version;
}

export interface TrainingStatus { required: boolean; complete: boolean; canSkip: boolean; version: string }

export async function trainingStatus(deps: Deps, userId: string): Promise<TrainingStatus> {
  const required = deps.config.TRAINING_REQUIRED === "true";
  const record = required ? await deps.repos.training.get(userId) : null;
  return { required, complete: !required || trainingComplete(record), canSkip: deps.config.TRAINING_ALLOW_SKIP === "true", version: TRAINING_INFO.version };
}

/**
 * Gate for the assistant itself: nobody, administrators included, uses it before completing the
 * workforce training. Returns false after replying 403.
 */
export async function requireTraining(deps: Deps, req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const status = await trainingStatus(deps, req.session!.userId);
  if (status.complete) return true;
  await apiError(reply, 403, "training_required", "Complete the workforce training before using the assistant");
  return false;
}

/**
 * Workforce training: the knowledge check, completed online. One record per user (attempts, best
 * score, when they passed) is the training log the Privacy Officer keeps; every submission is also
 * written to the audit log. There is nothing to sign: passing the check completes the training.
 */
export function registerTrainingRoutes(app: FastifyInstance, deps: Deps): void {
  const auth = requireAuth();
  const admin = requireAuth(["admin"]);
  const now = deps.now ?? (() => new Date());
  const repo = deps.repos.training;

  app.get("/api/training", { preHandler: auth }, async (req) => ({
    ...TRAINING_INFO,
    record: publicRecord(await repo.get(req.session!.userId)),
  }));

  app.post("/api/training/check", { preHandler: auth }, async (req, reply) => {
    const body = z.object({ answers: z.array(z.string().trim().regex(/^[A-Z]$/i)).length(TRAINING_INFO.total) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", `Answer all ${TRAINING_INFO.total} questions with one letter each`);
    const result = gradeTraining(body.data.answers);
    if (!result) return apiError(reply, 400, "bad_request", "Invalid answers");
    const s = req.session!;
    const t = now().toISOString();
    const prev = await repo.get(s.userId);
    // A new version of the training starts a fresh record; the old attempts stay in the audit log.
    const same = prev?.version === TRAINING_INFO.version ? prev : null;
    const record: TrainingRecord = {
      userId: s.userId,
      name: s.name || prev?.name || "",
      email: s.email || prev?.email || "",
      version: TRAINING_INFO.version,
      attempts: (same?.attempts ?? 0) + 1,
      lastScore: result.score,
      lastAttemptAt: t,
      bestScore: Math.max(same?.bestScore ?? 0, result.score),
      passedAt: same?.passedAt ?? (result.passed ? t : null),
      source: same?.source ?? "online",
      answers: body.data.answers.map((a) => a.toUpperCase()),
    };
    await repo.put(record);
    await audit(deps, req, { action: result.passed ? "training_check_passed" : "training_check_failed" });
    return { record: publicRecord(record), result };
  });

  // The in-app course: one module at a time. The module's questions are graded; it is complete once
  // every answer is right (retries allowed, the first attempt is what the log scores). When every
  // module is complete the check counts as passed and the training is done.
  app.post("/api/training/modules/:id", { preHandler: auth }, async (req, reply) => {
    const moduleId = Number((req.params as { id: string }).id);
    const module = TRAINING_INFO.modules.find((m) => m.id === moduleId);
    if (!module) return apiError(reply, 404, "not_found", "Unknown module");
    const body = z.object({ answers: z.record(z.string().regex(/^\d+$/), z.string().trim().regex(/^[A-Z]$/i)) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Answer every question of the module with one letter each");
    const graded = gradeModule(moduleId, body.data.answers);
    if (!graded) return apiError(reply, 400, "bad_request", "Answer every question of the module");
    const s = req.session!;
    const t = now().toISOString();
    const prev = await repo.get(s.userId);
    const same = prev?.version === TRAINING_INFO.version ? prev : null;
    const locked = TRAINING_INFO.modules.some((m) => m.id < moduleId && !same?.moduleProgress?.[String(m.id)]?.completedAt);
    if (locked) return apiError(reply, 409, "module_locked", "Complete the previous modules first");
    const progress: Record<string, TrainingModuleProgress> = { ...(same?.moduleProgress ?? {}) };
    const before = progress[String(moduleId)];
    progress[String(moduleId)] = {
      attempts: (before?.attempts ?? 0) + 1,
      firstTryCorrect: before ? before.firstTryCorrect : graded.correct,
      total: graded.total,
      completedAt: before?.completedAt ?? (graded.allCorrect ? t : null),
    };
    const courseComplete = TRAINING_INFO.modules.every((m) => progress[String(m.id)]?.completedAt);
    const firstTryScore = TRAINING_INFO.modules.reduce((sum, m) => sum + (progress[String(m.id)]?.firstTryCorrect ?? 0), 0);
    const record: TrainingRecord = {
      userId: s.userId,
      name: s.name || prev?.name || "",
      email: s.email || prev?.email || "",
      version: TRAINING_INFO.version,
      attempts: same?.attempts ?? 0,
      lastScore: courseComplete ? firstTryScore : (same?.lastScore ?? 0),
      lastAttemptAt: t,
      bestScore: courseComplete ? Math.max(same?.bestScore ?? 0, firstTryScore) : (same?.bestScore ?? 0),
      passedAt: same?.passedAt ?? (courseComplete ? t : null),
      source: same?.source ?? "online",
      moduleProgress: progress,
      answers: same?.answers ?? [],
    };
    await repo.put(record);
    if (graded.allCorrect && !before?.completedAt) await audit(deps, req, { action: "training_module_completed", meta: { module: moduleId, firstTryCorrect: progress[String(moduleId)]!.firstTryCorrect, total: graded.total } });
    if (courseComplete && !same?.passedAt) await audit(deps, req, { action: "training_check_passed", meta: { course: true, firstTryScore } });
    return { record: publicRecord(record), result: { results: graded.results, correct: graded.correct, total: graded.total, moduleComplete: graded.allCorrect, courseComplete } };
  });

  // "Skip training, I already know this": the user attests they completed the clinic's training
  // before. It unlocks the assistant and is recorded as an attestation, visibly distinct from a
  // completed check, so the Privacy Officer can follow up.
  app.post("/api/training/attest", { preHandler: auth }, async (req, reply) => {
    if (deps.config.TRAINING_ALLOW_SKIP !== "true") return apiError(reply, 403, "skip_not_allowed", "Skipping the training is not allowed");
    const body = z.object({ attested: z.literal(true) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Confirm the attestation to skip the training");
    const s = req.session!;
    const t = now().toISOString();
    const prev = await repo.get(s.userId);
    const same = prev?.version === TRAINING_INFO.version ? prev : null;
    if (same && trainingComplete(same)) return { record: publicRecord(same) };
    const record: TrainingRecord = {
      userId: s.userId,
      name: s.name || prev?.name || "",
      email: s.email || prev?.email || "",
      version: TRAINING_INFO.version,
      attempts: same?.attempts ?? 0,
      lastScore: same?.lastScore ?? 0,
      lastAttemptAt: same?.lastAttemptAt ?? t,
      bestScore: same?.bestScore ?? 0,
      passedAt: same?.passedAt ?? t,
      source: "attested",
      answers: same?.answers ?? [],
    };
    await repo.put(record);
    await audit(deps, req, { action: "training_skipped_attested" });
    return { record: publicRecord(record) };
  });

  // The training log: every user in the directory with their record (or none yet), plus records of
  // users no longer in the directory, so the log stays complete after offboarding.
  app.get("/api/admin/training", { preHandler: admin }, async () => {
    const [users, records] = await Promise.all([deps.directory.list(), repo.list()]);
    const byUser = new Map(records.map((r) => [r.userId, r]));
    const items = users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, enabled: u.enabled, inDirectory: true, record: publicRecord(byUser.get(u.id) ?? null) }));
    const known = new Set(users.map((u) => u.id));
    for (const r of records) {
      if (!known.has(r.userId)) items.push({ id: r.userId, name: r.name, email: r.email, role: "staff", enabled: true, inDirectory: false, record: publicRecord(r) });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { items, version: TRAINING_INFO.version, passingScore: TRAINING_INFO.passingScore, total: TRAINING_INFO.total };
  });

  // A completion done on paper (the paper knowledge check is on file): the Privacy Officer records it
  // so the log is complete and the user is not blocked from the assistant.
  app.post("/api/admin/training/:userId/paper", { preHandler: admin }, async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const body = z
      .object({
        completedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        score: z.number().int().min(0).max(TRAINING_INFO.total),
      })
      .safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Provide the completion date (YYYY-MM-DD) and the score");
    if (body.data.score < TRAINING_INFO.passingScore) return apiError(reply, 400, "not_passed", `A score of ${TRAINING_INFO.passingScore} of ${TRAINING_INFO.total} or better is required`);
    const user = (await deps.directory.list()).find((u) => u.id === userId);
    if (!user) return apiError(reply, 404, "not_found", "User not found");
    const completedDate = new Date(`${body.data.completedAt}T12:00:00Z`);
    if (Number.isNaN(completedDate.getTime()) || completedDate.toISOString().slice(0, 10) !== body.data.completedAt) return apiError(reply, 400, "bad_request", "Provide a real date (YYYY-MM-DD)");
    if (completedDate.getTime() > now().getTime() + 86_400_000) return apiError(reply, 400, "bad_request", "The completion date cannot be in the future");
    const completedAt = completedDate.toISOString();
    const prev = await repo.get(userId);
    const same = prev?.version === TRAINING_INFO.version ? prev : null;
    const record: TrainingRecord = {
      userId,
      name: user.name,
      email: user.email,
      version: TRAINING_INFO.version,
      attempts: same?.attempts ?? 0,
      lastScore: same?.lastScore ?? body.data.score,
      lastAttemptAt: same?.lastAttemptAt ?? completedAt,
      bestScore: Math.max(same?.bestScore ?? 0, body.data.score),
      passedAt: same?.passedAt ?? completedAt,
      source: same?.passedAt ? same.source : "paper",
      recordedBy: req.session!.userId,
      recordedAt: now().toISOString(),
      answers: same?.answers ?? [],
    };
    await repo.put(record);
    await audit(deps, req, { action: "admin_training_paper_recorded", meta: { targetUserId: userId, score: body.data.score, completedAt: body.data.completedAt } });
    return { record: publicRecord(record) };
  });
}
