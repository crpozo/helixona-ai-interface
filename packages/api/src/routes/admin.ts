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
