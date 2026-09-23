import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelByAlias, modelsForRole, ulid, type Conversation } from "@helixona/core";
import type { Deps } from "../deps.js";
import type { ConversationPatch } from "../repos/types.js";
import { apiError, audit, requireAuth } from "../app.js";
import { canReadProject } from "./projects.js";
import { requireTraining } from "./training.js";

export function publicConversation(c: Conversation) {
  const { userId: _u, systemPromptVersion: _v, lastInputTokens: _t, pinnedUntil: _p, ...rest } = c;
  return rest;
}

function defaultTitle(now: Date): string {
  // Título opaco: sin contenido de la conversación (evita PHI en listados e historial del navegador).
  const f = new Intl.DateTimeFormat("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/Los_Angeles" });
  return `Conversation ${f.format(now)}`;
}

export function registerConversationRoutes(app: FastifyInstance, deps: Deps): void {
  const now = deps.now ?? (() => new Date());
  const ttl = deps.config.RETENTION_DAYS * 86400;

  app.get("/api/conversations", { preHandler: requireAuth() }, async (req) => {
    const items = await deps.repos.conversations.list(req.session!.userId);
    return { items: items.map(publicConversation) };
  });

  app.post("/api/conversations", { preHandler: requireAuth() }, async (req, reply) => {
    if (!(await requireTraining(deps, req, reply))) return;
    const body = z.object({ modelAlias: z.string().min(2).max(32), projectId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).nullable().optional() }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const entry = modelByAlias(deps.catalog, body.data.modelAlias);
    if (!entry || !modelsForRole(deps.catalog, req.session!.roles).some((m) => m.alias === entry.alias)) return apiError(reply, 400, "unknown_model", "Model not available");
    let projectId: string | null = null;
    if (body.data.projectId) {
      const project = await deps.repos.projects.get(body.data.projectId);
      if (!project || !canReadProject(project, req.session!.userId)) return apiError(reply, 400, "unknown_project", "Project not found");
      projectId = project.id;
    }
    const t = now();
    const c: Conversation = {
      id: ulid(), userId: req.session!.userId, title: defaultTitle(t), modelAlias: entry.alias, modelId: entry.modelId,
      pinnedModel: null, pinReason: null, pinnedUntil: null, systemPromptVersion: deps.systemPrompt.version,
      createdAt: t.toISOString(), updatedAt: t.toISOString(), messageCount: 0, lastInputTokens: 0, projectId,
    };
    await deps.repos.conversations.create(c, ttl);
    await audit(deps, req, { action: "conversation_create", conversationId: c.id, model: c.modelId });
    return reply.code(201).send(publicConversation(c));
  });

  app.get("/api/conversations/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = await deps.repos.conversations.get(req.session!.userId, id);
    if (!c) return apiError(reply, 404, "not_found", "Conversation not found");
    const messages = await deps.repos.messages.list(id);
    await audit(deps, req, { action: "conversation_read", conversationId: id });
    return { conversation: publicConversation(c), messages: messages.map(({ conversationId: _c, seq: _s, ...m }) => m) };
  });

  app.patch("/api/conversations/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ title: z.string().trim().min(1).max(80).optional(), modelAlias: z.string().min(2).max(32).optional() }).safeParse(req.body);
    if (!body.success || (body.data.title === undefined && body.data.modelAlias === undefined)) return apiError(reply, 400, "bad_request", "Invalid request");
    const patch: ConversationPatch = {};
    if (body.data.title !== undefined) patch.title = body.data.title;
    if (body.data.modelAlias !== undefined) {
      const entry = modelByAlias(deps.catalog, body.data.modelAlias);
      if (!entry || !modelsForRole(deps.catalog, req.session!.roles).some((m) => m.alias === entry.alias)) return apiError(reply, 400, "unknown_model", "Model not available");
      // Explicit choice by the user: it also lifts any fallback pin.
      Object.assign(patch, { modelAlias: entry.alias, modelId: entry.modelId, pinnedModel: null, pinReason: null, pinnedUntil: null });
    }
    const c = await deps.repos.conversations.update(req.session!.userId, id, patch);
    if (!c) return apiError(reply, 404, "not_found", "Conversation not found");
    await audit(deps, req, { action: patch.modelId ? "conversation_model" : "conversation_title", conversationId: id, ...(patch.modelId ? { model: patch.modelId } : {}) });
    return publicConversation(c);
  });

  app.delete("/api/conversations/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const c = await deps.repos.conversations.get(req.session!.userId, id);
    if (!c) return apiError(reply, 404, "not_found", "Conversation not found");
    // Borrado explícito (no se espera al TTL).
    await deps.repos.messages.deleteAll(id);
    await deps.repos.conversations.delete(req.session!.userId, id);
    if (deps.attachments) await deps.attachments.deletePrefix(`conversations/${id}/`).catch(() => deps.log.warn("attachments_delete_failed", { conversationId: id }));
    await audit(deps, req, { action: "conversation_delete", conversationId: id });
    return reply.code(204).send();
  });
}
