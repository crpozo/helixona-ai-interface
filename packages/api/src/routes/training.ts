import type { FastifyInstance } from "fastify";
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
    const record: TrainingRecord = {
      userId: s.userId,
      name: s.name || prev?.name || "",
      email: s.email || prev?.email || "",
      version: TRAINING_INFO.version,
      attempts: (prev?.attempts ?? 0) + 1,
      lastScore: result.score,
      lastAttemptAt: t,
      bestScore: Math.max(prev?.bestScore ?? 0, result.score),
      passedAt: prev?.passedAt ?? (result.passed ? t : null),
      acknowledgedAt: prev?.acknowledgedAt ?? null,
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
    if (!prev?.passedAt) return apiError(reply, 409, "check_not_passed", "Pass the knowledge check before signing the acknowledgment");
    if (prev.acknowledgedAt) return { record: publicRecord(prev) };
    const record: TrainingRecord = { ...prev, name: s.name || prev.name, email: s.email || prev.email, acknowledgedAt: now().toISOString() };
    await repo.put(record);
    await audit(deps, req, { action: "training_acknowledged" });
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
    return { items };
  });
}
