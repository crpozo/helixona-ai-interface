import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelByAlias, modelsForRole, ulid, type Conversation } from "@helixona/core";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth } from "../app.js";

export function publicConversation(c: Conversation) {
  const { userId: _u, systemPromptVersion: _v, lastInputTokens: _t, pinnedUntil: _p, ...rest } = c;
  return rest;
}

function defaultTitle(now: Date): string {
  // Título opaco: sin contenido de la conversación (evita PHI en listados e historial del navegador).
  const f = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
  return `Conversación ${f.format(now)}`;
}

export function registerConversationRoutes(app: FastifyInstance, deps: Deps): void {
  const now = deps.now ?? (() => new Date());
  const ttl = deps.config.RETENTION_DAYS * 86400;

  app.get("/api/conversations", { preHandler: requireAuth() }, async (req) => {
    const items = await deps.repos.conversations.list(req.session!.userId);
    return { items: items.map(publicConversation) };
  });

  app.post("/api/conversations", { preHandler: requireAuth() }, async (req, reply) => {
    const body = z.object({ modelAlias: z.string().min(2).max(32) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Solicitud inválida");
    const entry = modelByAlias(deps.catalog, body.data.modelAlias);
    if (!entry || !modelsForRole(deps.catalog, req.session!.roles).some((m) => m.alias === entry.alias)) return apiError(reply, 400, "unknown_model", "Modelo no disponible");
    const t = now();
    const c: Conversation = {
      id: ulid(), userId: req.session!.userId, title: defaultTitle(t), modelAlias: entry.alias, modelId: entry.modelId,
      pinnedModel: null, pinReason: null, pinnedUntil: null, systemPromptVersion: deps.systemPrompt.version,
      createdAt: t.toISOString(), updatedAt: t.toISOString(), messageCount: 0, lastInputTokens: 0,
    };
    await deps.repos.conversations.create(c, ttl);
    await audit(deps, req, { action: "conversation_create", conversationId: c.id, model: c.modelId });
    return reply.code(201).send(publicConversation(c));
  });

  app.get("/api/conversations/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = await deps.repos.conversations.get(req.session!.userId, id);
    if (!c) return apiError(reply, 404, "not_found", "Conversación no encontrada");
    const messages = await deps.repos.messages.list(id);
    await audit(deps, req, { action: "conversation_read", conversationId: id });
    return { conversation: publicConversation(c), messages: messages.map(({ conversationId: _c, seq: _s, ...m }) => m) };
  });

  app.patch("/api/conversations/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ title: z.string().trim().min(1).max(80) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Solicitud inválida");
    const c = await deps.repos.conversations.update(req.session!.userId, id, { title: body.data.title });
    if (!c) return apiError(reply, 404, "not_found", "Conversación no encontrada");
    await audit(deps, req, { action: "conversation_title", conversationId: id });
    return publicConversation(c);
  });

  app.delete("/api/conversations/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = await deps.repos.conversations.get(req.session!.userId, id);
    if (!c) return apiError(reply, 404, "not_found", "Conversación no encontrada");
    // Borrado explícito (no se espera al TTL).
    await deps.repos.messages.deleteAll(id);
    await deps.repos.conversations.delete(req.session!.userId, id);
    await audit(deps, req, { action: "conversation_delete", conversationId: id });
    return reply.code(204).send();
  });
}
