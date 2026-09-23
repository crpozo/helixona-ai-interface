import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { TRAINING_INFO, gradeTraining } from "@helixona/core";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth } from "../app.js";
import type { TrainingRecord } from "../repos/types.js";

/** What the browser sees: the record without the raw answers. */
function publicRecord(r: TrainingRecord | null) {
  if (!r) return null;
  const { answers: _answers, ...rest } = r;
  return rest;
}

/** Passed the check and signed the acknowledgment for the current version of the training. */
export function trainingComplete(r: TrainingRecord | null): boolean {
  return !!r && !!r.passedAt && !!r.acknowledgedAt && r.version === TRAINING_INFO.version;
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
 * Workforce training: the knowledge check and the acknowledgment, completed online. One record per
 * user (attempts, best score, when they passed, when they acknowledged) is the training log the
 * Privacy Officer keeps; every submission is also written to the audit log.
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
      acknowledgedAt: same?.acknowledgedAt ?? null,
      source: same?.source ?? "online",
      answers: body.data.answers.map((a) => a.toUpperCase()),
    };
    await repo.put(record);
    await audit(deps, req, { action: result.passed ? "training_check_passed" : "training_check_failed" });
    return { record: publicRecord(record), result };
  });

  app.post("/api/training/acknowledgment", { preHandler: auth }, async (req, reply) => {
    const body = z.object({ accepted: z.literal(true) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Confirm the statements to sign the acknowledgment");
    const s = req.session!;
    const prev = await repo.get(s.userId);
    if (!prev?.passedAt || prev.version !== TRAINING_INFO.version) return apiError(reply, 409, "check_not_passed", "Pass the knowledge check before signing the acknowledgment");
    if (prev.acknowledgedAt) return { record: publicRecord(prev) };
    const record: TrainingRecord = { ...prev, name: s.name || prev.name, email: s.email || prev.email, acknowledgedAt: now().toISOString(), source: "online" };
    await repo.put(record);
    await audit(deps, req, { action: "training_acknowledged" });
    return { record: publicRecord(record) };
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
      acknowledgedAt: t,
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
    const items = users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, enabled: u.enabled, record: publicRecord(byUser.get(u.id) ?? null) }));
    const known = new Set(users.map((u) => u.id));
    for (const r of records) {
      if (!known.has(r.userId)) items.push({ id: r.userId, name: r.name, email: r.email, role: "staff", enabled: false, record: publicRecord(r) });
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return { items, version: TRAINING_INFO.version, passingScore: TRAINING_INFO.passingScore, total: TRAINING_INFO.total };
  });

  // A completion done on paper (the signed acknowledgment is on file): the Privacy Officer records it
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
    const completedAt = new Date(`${body.data.completedAt}T12:00:00Z`).toISOString();
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
      acknowledgedAt: same?.acknowledgedAt ?? completedAt,
      source: same?.acknowledgedAt ? same.source : "paper",
      recordedBy: req.session!.userId,
      recordedAt: now().toISOString(),
      answers: same?.answers ?? [],
    };
    await repo.put(record);
    await audit(deps, req, { action: "admin_training_paper_recorded", meta: { targetUserId: userId, score: body.data.score, completedAt: body.data.completedAt } });
    return { record: publicRecord(record) };
  });
}
