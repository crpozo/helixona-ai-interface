import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth, today } from "../app.js";
import { isBillingViewer } from "../billing/viewer.js";
import { aggregateMonths, dailyEstimates, monthsBack, spentSince, type CreditsRecord } from "../billing/monthly.js";

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

  app.post("/api/admin/users/:id/disable", { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.session!.userId) return apiError(reply, 400, "bad_request", "You cannot disable your own account");
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

  // Email never arrived: a new temporary password, shown once to the administrator to hand over in
  // person or by phone. The password itself is never logged.
  app.post("/api/admin/users/:id/temporary-password", { preHandler: admin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (id === req.session!.userId) return apiError(reply, 400, "bad_request", "Use “Forgot your password?” for your own account");
    let temporaryPassword: string;
    try {
      temporaryPassword = await deps.directory.setTemporaryPassword(id);
    } catch (e) {
      deps.log.warn("admin_temporary_password_failed", { targetUserId: id, error: (e as { name?: string }).name ?? "error" });
      return apiError(reply, 404, "not_found", "User not found");
    }
    const n = await deps.repos.sessions.deleteAllForUser(id);
    await audit(deps, req, { action: "admin_user_temporary_password", meta: { targetUserId: id, sessionsRevoked: n } });
    return { temporaryPassword };
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

  // ---- Billing view: usage by month and the credits left, for the administrators named in BILLING_VIEWER_EMAILS.
  const Credits = z.object({ purchasedUsd: z.coerce.number().min(0).max(10_000_000), asOf: Day, note: z.string().trim().max(200).default("") });
  const notViewer = (reply: Parameters<typeof apiError>[0]) => apiError(reply, 403, "forbidden", "The billing view is limited to the accounts named in the server settings.");

  app.get("/api/admin/billing", { preHandler: admin }, async (req, reply) => {
    const s = req.session!;
    if (!isBillingViewer(deps.config, s)) return notViewer(reply);
    const months = monthsBack(now(), 12);
    const fromDay = `${months[months.length - 1]}-01`;
    const credits = await deps.repos.settings.get<CreditsRecord>("billing-credits");
    // Spending counts from the credits' date, which may be earlier than the months shown.
    const since = credits && credits.asOf < fromDay ? credits.asOf : fromDay;
    const rows = await deps.repos.usage.listFrom(since);
    const anthropic: { configured: boolean; months: Array<{ month: string; costUsd: number }>; sinceAnchorUsd: number | null; fetchedAt: string | null; error: string | null } = { configured: !!deps.billing, months: [], sinceAnchorUsd: null, fetchedAt: null, error: null };
    if (deps.billing) {
      try {
        const r = await deps.billing.report(since);
        anthropic.fetchedAt = r.fetchedAt;
        anthropic.months = months.map((m) => ({ month: m, costUsd: r.days.filter((d) => d.day.startsWith(m)).reduce((n, d) => n + d.usd, 0) }));
        if (credits) anthropic.sinceAnchorUsd = spentSince(r.days, credits.asOf);
      } catch (e) {
        anthropic.error = e instanceof Error ? e.message : "The cost report could not be read";
        deps.log.warn("billing_report_failed", { errorClass: e instanceof Error ? e.name : "unknown" });
      }
    }
    let remaining: { usd: number; spentUsd: number; basis: "anthropic" | "estimate" } | null = null;
    if (credits) {
      const spentUsd = anthropic.sinceAnchorUsd ?? spentSince(dailyEstimates(rows), credits.asOf);
      remaining = { usd: credits.purchasedUsd - spentUsd, spentUsd, basis: anthropic.sinceAnchorUsd !== null ? "anthropic" : "estimate" };
    }
    return { months: aggregateMonths(rows, months), credits, anthropic, remaining };
  });

  app.put("/api/admin/billing/credits", { preHandler: admin }, async (req, reply) => {
    const s = req.session!;
    if (!isBillingViewer(deps.config, s)) return notViewer(reply);
    const body = Credits.safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const record: CreditsRecord = { ...body.data, updatedAt: now().toISOString(), updatedBy: s.name };
    await deps.repos.settings.put("billing-credits", record);
    // Amount and date only: the note is free text and stays out of the audit log.
    await audit(deps, req, { action: "admin_billing_credits", meta: { purchasedUsd: record.purchasedUsd, asOf: record.asOf } });
    return record;
  });
}
