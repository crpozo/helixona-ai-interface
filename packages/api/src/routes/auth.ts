import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelsForRole, type Role } from "@helixona/core";
import type { Deps } from "../deps.js";
import type { OidcPending } from "../auth/cognito.js";
import { SESSION_COOKIE } from "../auth/session.js";
import { apiError, audit, requireAuth } from "../app.js";

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

  app.post("/api/auth/dev-login", async (req, reply) => {
    if (config.AUTH_MODE !== "dev" || config.NODE_ENV === "production") return apiError(reply, 404, "not_found", "Recurso no encontrado");
    const body = z.object({ username: z.string().regex(/^[a-z0-9._-]{2,40}$/i), role: z.enum(["staff", "admin"]).default("staff") }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Solicitud inválida");
    const roles: Role[] = body.data.role === "admin" ? ["staff", "admin"] : ["staff"];
    const userId = `dev-${body.data.username.toLowerCase()}`;
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
      catalog: {
        defaultAlias: deps.catalog.defaultAlias,
        effort: deps.catalog.effort,
        models: [
          ...deps.catalog.models.map((m) => ({ alias: m.alias, modelId: m.modelId, label: m.label, description: m.description, costFactor: m.costFactor, available: modelsForRole(deps.catalog, s.roles).some((x) => x.alias === m.alias) })),
          // Modelos solo de respaldo: no seleccionables, pero la UI necesita su etiqueta.
          ...deps.catalog.fallbackModels.map((m) => ({ alias: m.modelId, modelId: m.modelId, label: m.label, description: "Solo como respaldo", costFactor: 0, available: false })),
        ],
      },
      limits: { maxMessageChars: config.MAX_MESSAGE_CHARS, contextLimitTokens: config.CONTEXT_LIMIT_TOKENS },
    };
  });
}
