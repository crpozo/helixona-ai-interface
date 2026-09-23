import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { modelByAlias, modelsForRole, ulid, type Conversation, type Project } from "@helixona/core";
import type { Deps } from "../deps.js";
import type { ConversationPatch, Session } from "../repos/types.js";
import { apiError, audit, requireAuth } from "../app.js";
import { canReadProject, projectPartition, sharedProjectsFor } from "./projects.js";
import { requireTraining } from "./training.js";

export function publicConversation(c: Conversation) {
  const { userId: _u, systemPromptVersion: _v, lastInputTokens: _t, pinnedUntil: _p, busyUntil: _b, ...rest } = c;
  return rest;
}

/** A conversation the user may see, with the partition it is stored under and its usable project. */
export interface LocatedConversation {
  conv: Conversation;
  /** The user's own partition, or a shared project's. */
  key: string;
  /** The conversation's project when the user may still use it (its instructions and files apply). */
  project: Project | null;
}

/** Finds a conversation of the user's own, or one of a shared project they take part in. */
export async function locateConversation(deps: Deps, s: Session, id: string): Promise<LocatedConversation | null> {
  const own = await deps.repos.conversations.get(s.userId, id);
  if (own) {
    const project = own.projectId ? await deps.repos.projects.get(own.projectId) : null;
    return { conv: own, key: s.userId, project: project && canReadProject(project, s.userId) ? project : null };
  }
  for (const p of await sharedProjectsFor(deps, s.userId)) {
    const c = await deps.repos.conversations.get(projectPartition(p.id), id);
    if (c) return { conv: c, key: projectPartition(p.id), project: p };
  }
  return null;
}

/** Deleting a shared conversation: whoever started it, the project owner, or an administrator. */
function canDelete(l: LocatedConversation, s: Session): boolean {
  return l.key === s.userId || l.conv.createdBy === s.userId || l.project?.ownerId === s.userId || s.roles.includes("admin");
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
    const s = req.session!;
    const items = await deps.repos.conversations.list(s.userId);
    for (const p of await sharedProjectsFor(deps, s.userId)) items.push(...(await deps.repos.conversations.list(projectPartition(p.id))));
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items: items.map(publicConversation) };
  });

  app.post("/api/conversations", { preHandler: requireAuth() }, async (req, reply) => {
    if (!(await requireTraining(deps, req, reply))) return;
    const body = z.object({ modelAlias: z.string().min(2).max(32), projectId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).nullable().optional() }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const s = req.session!;
    const entry = modelByAlias(deps.catalog, body.data.modelAlias);
    if (!entry || !modelsForRole(deps.catalog, s.roles).some((m) => m.alias === entry.alias)) return apiError(reply, 400, "unknown_model", "Model not available");
    let projectId: string | null = null;
    let key = s.userId;
    if (body.data.projectId) {
      const project = await deps.repos.projects.get(body.data.projectId);
      if (!project || !canReadProject(project, s.userId)) return apiError(reply, 400, "unknown_project", "Project not found");
      projectId = project.id;
      // A shared project's conversations belong to the project: every member finds them there.
      if (project.visibility === "shared") key = projectPartition(project.id);
    }
    const t = now();
    const c: Conversation = {
      id: ulid(), userId: key, title: defaultTitle(t), modelAlias: entry.alias, modelId: entry.modelId,
      pinnedModel: null, pinReason: null, pinnedUntil: null, systemPromptVersion: deps.systemPrompt.version,
      createdAt: t.toISOString(), updatedAt: t.toISOString(), messageCount: 0, lastInputTokens: 0, projectId,
      createdBy: s.userId, createdByName: s.name,
    };
    await deps.repos.conversations.create(c, ttl);
    await audit(deps, req, { action: "conversation_create", conversationId: c.id, model: c.modelId, ...(projectId ? { meta: { projectId, shared: key !== s.userId } } : {}) });
    return reply.code(201).send(publicConversation(c));
  });

  app.get("/api/conversations/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const l = await locateConversation(deps, req.session!, id);
    if (!l) return apiError(reply, 404, "not_found", "Conversation not found");
    const messages = await deps.repos.messages.list(id);
    await audit(deps, req, { action: "conversation_read", conversationId: id });
    return { conversation: publicConversation(l.conv), messages: messages.map(({ conversationId: _c, seq: _s, ...m }) => m) };
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
    const l = await locateConversation(deps, req.session!, id);
    if (!l) return apiError(reply, 404, "not_found", "Conversation not found");
    const c = await deps.repos.conversations.update(l.key, id, patch);
    if (!c) return apiError(reply, 404, "not_found", "Conversation not found");
    await audit(deps, req, { action: patch.modelId ? "conversation_model" : "conversation_title", conversationId: id, ...(patch.modelId ? { model: patch.modelId } : {}) });
    return publicConversation(c);
  });

  app.delete("/api/conversations/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const l = await locateConversation(deps, req.session!, id);
    if (!l) return apiError(reply, 404, "not_found", "Conversation not found");
    if (!canDelete(l, req.session!)) return apiError(reply, 403, "forbidden", "Only the person who started this conversation, the project owner or an administrator can delete it");
    // Borrado explícito (no se espera al TTL).
    await deps.repos.messages.deleteAll(id);
    await deps.repos.conversations.delete(l.key, id);
    if (deps.attachments) await deps.attachments.deletePrefix(`conversations/${id}/`).catch(() => deps.log.warn("attachments_delete_failed", { conversationId: id }));
    await audit(deps, req, { action: "conversation_delete", conversationId: id });
    return reply.code(204).send();
  });
}
