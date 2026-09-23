import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth, today } from "../app.js";

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function registerAdminRoutes(app: FastifyInstance, deps: Deps): void {
  const admin = requireAuth(["admin"]);
  const now = deps.now ?? (() => new Date());

  app.get("/api/admin/users", { preHandler: admin }, async () => ({ items: await deps.directory.list() }));

  app.post("/api/admin/users", { preHandler: admin }, async (req, reply) => {
    const body = z.object({ email: z.string().email().max(120), name: z.string().trim().min(1).max(80), role: z.enum(["staff", "admin"]) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const u = await deps.directory.create(body.data);
    await audit(deps, req, { action: "admin_user_create", meta: { targetUserId: u.id, role: u.role } });
    return reply.code(201).send(u);
  });

  app.post("/api/admin/users/:id/disable", { preHandler: admin }, async (req) => {
    const { id } = req.params as { id: string };
    await deps.directory.setEnabled(id, false);
    // Revocación real: se borran sus sesiones del lado servidor.
    const n = await deps.repos.sessions.deleteAllForUser(id);
    await audit(deps, req, { action: "admin_user_disable", meta: { targetUserId: id, sessionsRevoked: n } });
    return { ok: true };
  });

  app.post("/api/admin/users/:id/enable", { preHandler: admin }, async (req) => {
    const { id } = req.params as { id: string };
    await deps.directory.setEnabled(id, true);
    await audit(deps, req, { action: "admin_user_enable", meta: { targetUserId: id } });
    return { ok: true };
  });

  app.post("/api/admin/users/:id/role", { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ role: z.enum(["staff", "admin"]) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    if (id === req.session!.userId) return apiError(reply, 400, "bad_request", "You cannot change your own role");
    await deps.directory.setRole(id, body.data.role);
    // The role lives in the session: revoke the user's sessions so the next sign-in picks it up.
    const n = await deps.repos.sessions.deleteAllForUser(id);
    await audit(deps, req, { action: "admin_user_role", meta: { targetUserId: id, role: body.data.role, sessionsRevoked: n } });
    return { ok: true };
  });

  // New invitation email with a fresh temporary password for a user who has not signed in yet.
  app.post("/api/admin/users/:id/invitation/resend", { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await deps.directory.resendInvitation(id);
    } catch (e) {
      deps.log.warn("admin_invitation_resend_failed", { targetUserId: id, error: (e as { name?: string }).name ?? "error" });
      return apiError(reply, 409, "not_invited", "Only accounts that have not completed their first sign-in can receive a new invitation");
    }
    await audit(deps, req, { action: "admin_user_invitation_resent", meta: { targetUserId: id } });
    return { ok: true };
  });

  // Lost or replaced phone: forget the authenticator; the user enrolls a new one at the next sign-in.
  app.post("/api/admin/users/:id/mfa/reset", { preHandler: admin }, async (req) => {
    const { id } = req.params as { id: string };
    await deps.directory.resetMfa(id);
    const n = await deps.repos.sessions.deleteAllForUser(id);
    await audit(deps, req, { action: "admin_user_mfa_reset", meta: { targetUserId: id, sessionsRevoked: n } });
    return { ok: true };
  });

  app.get("/api/admin/audit", { preHandler: admin }, async (req, reply) => {
    const q = z.object({ day: Day.default(today(now)) }).safeParse(req.query);
    if (!q.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const items = await deps.repos.audit.listByDay(q.data.day);
    await audit(deps, req, { action: "admin_audit_read", meta: { day: q.data.day } });
    return { items };
  });

  app.get("/api/admin/usage", { preHandler: admin }, async (req, reply) => {
    const q = z.object({ day: Day.default(today(now)) }).safeParse(req.query);
    if (!q.success) return apiError(reply, 400, "bad_request", "Invalid request");
    return { items: await deps.repos.usage.listByDay(q.data.day) };
  });
}
