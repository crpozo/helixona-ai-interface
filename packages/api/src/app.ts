import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ulid, type Role } from "@helixona/core";
import type { Deps } from "./deps.js";
import type { Session, AuditEvent } from "./repos/types.js";
import { SESSION_COOKIE } from "./auth/session.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerChatRoute } from "./routes/chat.js";
import { registerAdminRoutes } from "./routes/admin.js";

declare module "fastify" {
  interface FastifyRequest { session: Session | null; requestId: string }
}

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

export function apiError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}

export function requireAuth(roles: Role[] = ["staff"]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.session) return apiError(reply, 401, "unauthenticated", "Inicia sesión para continuar");
    if (!roles.some((r) => req.session!.roles.includes(r))) return apiError(reply, 403, "forbidden", "No tienes permiso para esta acción");
  };
}

export function today(now: () => Date): string { return now().toISOString().slice(0, 10); }

export async function audit(deps: Deps, req: FastifyRequest, e: Omit<AuditEvent, "id" | "ts" | "day" | "userId"> & { userId?: string }): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const ev: AuditEvent = { id: ulid(), ts: now.toISOString(), day: now.toISOString().slice(0, 10), userId: e.userId ?? req.session?.userId ?? "anonymous", ...e };
  await deps.repos.audit.put(ev);
  deps.log.info("audit", { action: ev.action, userId: ev.userId, conversationId: ev.conversationId, model: ev.model, servedBy: ev.servedBy, fallbackReason: ev.fallbackReason, refusalCategory: ev.refusalCategory ?? undefined, stopReason: ev.stopReason, latencyMs: ev.latencyMs, estimatedUsd: ev.usage?.estimatedUsd, requestId: req.requestId });
}

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 256 * 1024, genReqId: () => ulid() });
  const secure = config.APP_BASE_URL.startsWith("https://");

  await app.register(cookie);

  // Cuerpos JSON vacíos (p. ej. POST sin payload con content-type application/json) se aceptan.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 256 * 1024 }, (_req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") return done(null, undefined);
    try { done(null, JSON.parse(text)); } catch { const e = new Error("json") as Error & { statusCode?: number }; e.statusCode = 400; done(e, undefined); }
  });

  // Cabeceras de seguridad en todas las respuestas; nada cacheable en /api.
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("content-security-policy", CSP);
    if (secure) reply.header("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
    return payload;
  });

  // Sesión + CSRF (cabecera personalizada obligatoria en mutaciones).
  app.addHook("onRequest", async (req, reply) => {
    req.requestId = String(req.id);
    req.session = null;
    if (!req.url.startsWith("/api/")) return;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method) && req.headers["x-requested-with"] !== "helixona") {
      return apiError(reply, 403, "csrf", "Cabecera X-Requested-With requerida");
    }
    const resolved = await deps.sessions.resolve(req.cookies[SESSION_COOKIE]);
    if (resolved?.expired) {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      await audit(deps, req, { action: "session_expired", userId: resolved.session.userId });
      return;
    }
    if (resolved) req.session = resolved.session;
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; validation?: unknown; name?: string; code?: string };
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    // Nunca se serializa el error completo: puede contener el cuerpo de la petición.
    deps.log.error("request_error", { requestId: req.requestId, route: req.routeOptions?.url ?? req.url.split("?")[0], method: req.method, status, errorClass: e.name ?? "Error", errorCode: e.code });
    if (reply.sent) return;
    if (status === 400 || e.validation) return apiError(reply, 400, "bad_request", "Solicitud inválida");
    return apiError(reply, status, status === 500 ? "internal" : "error", "No se pudo completar la solicitud");
  });

  app.get("/api/health", async () => ({ ok: true, version: process.env["APP_VERSION"] ?? "dev" }));

  registerAuthRoutes(app, deps, secure);
  registerConversationRoutes(app, deps);
  registerChatRoute(app, deps);
  registerAdminRoutes(app, deps);

  // SPA compilada (mismo origen, sin CORS). Cualquier ruta no-API devuelve index.html.
  const dist = config.WEB_DIST ?? resolve(process.cwd(), "../web/dist");
  if (existsSync(resolve(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: dist, wildcard: false, index: false, maxAge: "1h", immutable: false, setHeaders: (res, path) => { if (path.endsWith("index.html")) res.setHeader("cache-control", "no-store"); } });
    const index = readFileSync(resolve(dist, "index.html"), "utf8");
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return apiError(reply, 404, "not_found", "Recurso no encontrado");
      if (req.method !== "GET") return apiError(reply, 405, "method_not_allowed", "Método no permitido");
      return reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(index);
    });
  } else {
    app.setNotFoundHandler((req, reply) => apiError(reply, 404, "not_found", req.url.startsWith("/api/") ? "Recurso no encontrado" : "Frontend no compilado (packages/web/dist)"));
  }

  return app;
}
