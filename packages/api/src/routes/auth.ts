import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { modelsForRole, type Role } from "@helixona/core";
import type { Deps } from "../deps.js";
import type { IdentityResult, OidcPending } from "../auth/cognito.js";
import { AttemptLimiter, PasswordAuthError, type PasswordAuthResult } from "../auth/password.js";
import { SESSION_COOKIE } from "../auth/session.js";
import { apiError, audit, requireAuth } from "../app.js";
import { ALLOWED_TYPES } from "../attachments/policy.js";
import { trainingStatus } from "./training.js";

const OIDC_COOKIE = "hx_oidc";

export function registerAuthRoutes(app: FastifyInstance, deps: Deps, secure: boolean): void {
  const { config } = deps;
  const oidcCookieOpts = { httpOnly: true, secure, sameSite: "lax" as const, path: "/api/auth", maxAge: 600, signed: true };

  app.get("/api/auth/login", async (_req, reply) => {
    if (config.AUTH_MODE === "dev") return reply.redirect("/login");
    const { url, pending } = deps.identity.beginLogin();
    reply.setCookie(OIDC_COOKIE, JSON.stringify(pending), oidcCookieOpts);
    return reply.redirect(url);
  });

  app.get("/api/auth/callback", async (req, reply) => {
    if (config.AUTH_MODE === "dev") return reply.redirect("/login");
    const q = z.object({ code: z.string().min(1), state: z.string().min(1) }).safeParse(req.query);
    const raw = req.cookies[OIDC_COOKIE];
    const unsigned = raw ? reply.unsignCookie(raw) : null;
    reply.clearCookie(OIDC_COOKIE, { path: "/api/auth" });
    if (!q.success || !unsigned?.valid || !unsigned.value) return reply.redirect("/login?error=oidc");
    const pending = JSON.parse(unsigned.value) as OidcPending;
    if (pending.state !== q.data.state || pending.exp < Date.now()) return reply.redirect("/login?error=state");
    try {
      const id = await deps.identity.completeLogin(q.data.code, pending);
      const { cookie } = await deps.sessions.create({ id: id.id, email: id.email, name: id.name, roles: id.roles }, id.refreshToken);
      reply.setCookie(SESSION_COOKIE, cookie, deps.sessions.cookieOptions(secure));
      await audit(deps, req, { action: "login", userId: id.id, meta: { mode: "cognito" } });
      return reply.redirect("/");
    } catch (e) {
      deps.log.warn("login_failed", { errorClass: e instanceof Error ? e.name : "unknown", reason: e instanceof Error ? e.message.slice(0, 80) : undefined });
      return reply.redirect("/login?error=login");
    }
  });

  // ---- Password sign-in inside the app (Cognito USER_PASSWORD_AUTH through the API) ----
  const attempts = new AttemptLimiter(12, 5 * 60_000);
  const finishSignIn = async (req: FastifyRequest, reply: FastifyReply, id: IdentityResult) => {
    const { cookie } = await deps.sessions.create({ id: id.id, email: id.email, name: id.name, roles: id.roles }, id.refreshToken);
    reply.setCookie(SESSION_COOKIE, cookie, deps.sessions.cookieOptions(secure));
    await audit(deps, req, { action: "login", userId: id.id, meta: { mode: "password" } });
    return { ok: true as const };
  };
  const runPasswordStep = async (req: FastifyRequest, reply: FastifyReply, step: () => Promise<PasswordAuthResult>) => {
    if (config.AUTH_MODE === "dev" || !deps.passwordAuth) return apiError(reply, 404, "not_found", "Resource not found");
    if (!attempts.allow(req.ip)) return apiError(reply, 429, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");
    try {
      const r = await step();
      if (r.kind === "challenge") return r.challenge === "MFA_SETUP" ? { challenge: r.challenge, session: r.session, secret: r.secret, otpauthUrl: r.otpauthUrl } : { challenge: r.challenge, session: r.session };
      return await finishSignIn(req, reply, r.identity);
    } catch (e) {
      if (e instanceof PasswordAuthError) {
        deps.log.warn("password_auth_failed", { errorClass: e.code, requestId: req.requestId });
        return apiError(reply, e.status, e.code, e.message);
      }
      throw e;
    }
  };
  const Email = z.string().trim().toLowerCase().email().max(120);
  const Password = z.string().min(1).max(256);

  app.post("/api/auth/password/signin", async (req, reply) => {
    const body = z.object({ email: Email, password: Password }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    return runPasswordStep(req, reply, () => deps.passwordAuth!.signIn(body.data.email, body.data.password));
  });

  app.post("/api/auth/password/challenge", async (req, reply) => {
    const body = z
      .object({ email: Email, session: z.string().min(1).max(4096), challenge: z.enum(["NEW_PASSWORD_REQUIRED", "MFA", "MFA_SETUP"]), newPassword: Password.optional(), code: z.string().trim().regex(/^\d{6}$/).optional() })
      .safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const { email, session, challenge, newPassword, code } = body.data;
    if ((challenge !== "NEW_PASSWORD_REQUIRED" && !code) || (challenge === "NEW_PASSWORD_REQUIRED" && !newPassword)) return apiError(reply, 400, "bad_request", "Invalid request");
    return runPasswordStep(req, reply, () => deps.passwordAuth!.respond(email, session, challenge, { newPassword, code }));
  });

  app.post("/api/auth/password/forgot", async (req, reply) => {
    const body = z.object({ email: Email }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    if (config.AUTH_MODE === "dev" || !deps.passwordAuth) return apiError(reply, 404, "not_found", "Resource not found");
    if (!attempts.allow(req.ip)) return apiError(reply, 429, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");
    try {
      await deps.passwordAuth.forgotPassword(body.data.email);
    } catch (e) {
      if (e instanceof PasswordAuthError) return apiError(reply, e.status, e.code, e.message);
      throw e;
    }
    await audit(deps, req, { action: "password_reset_requested" });
    return { ok: true };
  });

  app.post("/api/auth/password/reset", async (req, reply) => {
    const body = z.object({ email: Email, code: z.string().trim().min(4).max(12), newPassword: Password }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    if (config.AUTH_MODE === "dev" || !deps.passwordAuth) return apiError(reply, 404, "not_found", "Resource not found");
    if (!attempts.allow(req.ip)) return apiError(reply, 429, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");
    try {
      await deps.passwordAuth.resetPassword(body.data.email, body.data.code, body.data.newPassword);
    } catch (e) {
      if (e instanceof PasswordAuthError) return apiError(reply, e.status, e.code, e.message);
      throw e;
    }
    await audit(deps, req, { action: "password_reset_completed" });
    return { ok: true };
  });

  app.post("/api/auth/dev-login", async (req, reply) => {
    if (config.AUTH_MODE !== "dev" || config.NODE_ENV === "production") return apiError(reply, 404, "not_found", "Resource not found");
    const body = z.object({ username: z.string().regex(/^[a-z0-9._-]{2,40}$/i), role: z.enum(["staff", "admin"]).default("staff") }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const roles: Role[] = body.data.role === "admin" ? ["staff", "admin"] : ["staff"];
    const userId = `dev-${body.data.username.toLowerCase()}`;
    const existing = (await deps.directory.list()).find((u) => u.id === userId);
    if (existing && !existing.enabled) return apiError(reply, 403, "account_disabled", "This account is disabled");
    const { cookie } = await deps.sessions.create({ id: userId, email: `${body.data.username}@dev.local`, name: body.data.username, roles }, null);
    reply.setCookie(SESSION_COOKIE, cookie, deps.sessions.cookieOptions(secure));
    await audit(deps, req, { action: "login", userId, meta: { mode: "dev" } });
    return { ok: true };
  });

  app.post("/api/auth/logout", { preHandler: requireAuth() }, async (req, reply) => {
    const s = req.session!;
    await deps.sessions.destroy(s.id);
    await deps.identity.revoke(s.refreshToken);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.header("clear-site-data", '"cache", "storage"');
    await audit(deps, req, { action: "logout", userId: s.userId });
    return { logoutUrl: deps.identity.logoutUrl() };
  });

  app.get("/api/me", { preHandler: requireAuth() }, async (req) => {
    const s = req.session!;
    const idleExp = new Date(s.expiresAt * 1000).toISOString();
    const expiresAt = idleExp < s.absoluteExpiresAt ? idleExp : s.absoluteExpiresAt;
    return {
      user: { id: s.userId, email: s.email, name: s.name, roles: s.roles },
      session: { expiresAt, idleTimeoutSeconds: config.SESSION_IDLE_SECONDS },
      training: await trainingStatus(deps, s.userId),
      catalog: {
        defaultAlias: deps.catalog.defaultAlias,
        effort: deps.catalog.effort,
        models: [
          ...deps.catalog.models.map((m) => ({ alias: m.alias, modelId: m.modelId, label: m.label, description: m.description, costFactor: m.costFactor, available: modelsForRole(deps.catalog, s.roles).some((x) => x.alias === m.alias) })),
          // Modelos solo de respaldo: no seleccionables, pero la UI necesita su etiqueta.
          ...deps.catalog.fallbackModels.map((m) => ({ alias: m.modelId, modelId: m.modelId, label: m.label, description: "Fallback only", costFactor: 0, available: false })),
        ],
      },
      limits: {
        maxMessageChars: config.MAX_MESSAGE_CHARS,
        contextLimitTokens: config.CONTEXT_LIMIT_TOKENS,
        attachments: { enabled: deps.attachments !== null, maxMb: config.MAX_ATTACHMENT_MB, maxPerMessage: config.MAX_ATTACHMENTS_PER_MESSAGE, accept: Object.keys(ALLOWED_TYPES) },
      },
    };
  });
}
