import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { estimateAttachmentTokens, ulid, type Project } from "@helixona/core";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth } from "../app.js";
import { ALLOWED_TYPES, MAX_PROJECT_FILES, MAX_PROJECT_KNOWLEDGE_TOKENS, maxBytesFor, projectKnowledgeKey, safeName } from "../attachments/policy.js";
import { AttachmentProblem, verifyUpload } from "../attachments/documents.js";

/**
 * Projects work like Claude.ai projects: instructions plus knowledge files that every conversation
 * inside the project receives. `private` projects belong to their owner; `clinic` projects are
 * visible to everyone and editable by their owner and administrators.
 */
export function canReadProject(p: Project, userId: string): boolean {
  return p.ownerId === userId || p.visibility === "clinic";
}
export function canEditProject(p: Project, userId: string, roles: string[]): boolean {
  return p.ownerId === userId || roles.includes("admin");
}

function publicProject(p: Project, userId: string, roles: string[]) {
  return {
    id: p.id,
    ownerId: p.ownerId,
    name: p.name,
    description: p.description,
    instructions: p.instructions,
    visibility: p.visibility,
    knowledge: p.knowledge.map(({ key: _k, ...meta }) => meta),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    canEdit: canEditProject(p, userId, roles),
  };
}

const Name = z.string().trim().min(1).max(80);
const Description = z.string().trim().max(300);
const Instructions = z.string().max(20_000);
const Visibility = z.enum(["private", "clinic"]);

export function registerProjectRoutes(app: FastifyInstance, deps: Deps): void {
  const now = deps.now ?? (() => new Date());

  const load = async (req: FastifyRequest, reply: FastifyReply, write: boolean): Promise<Project | null> => {
    const { id } = req.params as { id: string };
    const p = await deps.repos.projects.get(id);
    if (!p || !canReadProject(p, req.session!.userId)) {
      await apiError(reply, 404, "not_found", "Project not found");
      return null;
    }
    if (write && !canEditProject(p, req.session!.userId, req.session!.roles)) {
      await apiError(reply, 403, "forbidden", "Only the project owner or an administrator can change this project");
      return null;
    }
    return p;
  };

  app.get("/api/projects", { preHandler: requireAuth() }, async (req) => {
    const all = await deps.repos.projects.list();
    const s = req.session!;
    return { items: all.filter((p) => canReadProject(p, s.userId)).sort((a, b) => a.name.localeCompare(b.name)).map((p) => publicProject(p, s.userId, s.roles)) };
  });

  app.post("/api/projects", { preHandler: requireAuth() }, async (req, reply) => {
    const body = z.object({ name: Name, description: Description.default(""), instructions: Instructions.default(""), visibility: Visibility.default("private") }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const t = now().toISOString();
    const p: Project = { id: ulid(), ownerId: req.session!.userId, ...body.data, knowledge: [], createdAt: t, updatedAt: t };
    await deps.repos.projects.create(p);
    await audit(deps, req, { action: "project_create", meta: { projectId: p.id, visibility: p.visibility } });
    return reply.code(201).send(publicProject(p, req.session!.userId, req.session!.roles));
  });

  app.get("/api/projects/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const p = await load(req, reply, false);
    if (!p) return reply;
    return publicProject(p, req.session!.userId, req.session!.roles);
  });

  app.patch("/api/projects/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const body = z.object({ name: Name.optional(), description: Description.optional(), instructions: Instructions.optional(), visibility: Visibility.optional() }).safeParse(req.body);
    if (!body.success || Object.keys(body.data).length === 0) return apiError(reply, 400, "bad_request", "Invalid request");
    const p = await load(req, reply, true);
    if (!p) return reply;
    const updated = await deps.repos.projects.update(p.id, { ...body.data, updatedAt: now().toISOString() });
    if (!updated) return apiError(reply, 404, "not_found", "Project not found");
    await audit(deps, req, { action: "project_update", meta: { projectId: p.id, fields: Object.keys(body.data).join(",") } });
    return publicProject(updated, req.session!.userId, req.session!.roles);
  });

  app.delete("/api/projects/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const p = await load(req, reply, true);
    if (!p) return reply;
    await deps.repos.projects.delete(p.id);
    if (deps.attachments) await deps.attachments.deletePrefix(`projects/${p.id}/`).catch(() => deps.log.warn("project_knowledge_delete_failed", { projectId: p.id }));
    await audit(deps, req, { action: "project_delete", meta: { projectId: p.id } });
    return reply.code(204).send();
  });

  // ---- Knowledge files: presign, then register once the browser has uploaded ----
  app.post("/api/projects/:id/knowledge", { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.attachments) return apiError(reply, 400, "attachments_disabled", "File uploads are not enabled on this server");
    const body = z.object({ name: z.string().trim().min(1).max(200), size: z.number().int().positive(), contentType: z.string().min(1).max(100) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const p = await load(req, reply, true);
    if (!p) return reply;
    if (p.knowledge.length >= MAX_PROJECT_FILES) return apiError(reply, 400, "too_many_files", `A project can hold up to ${MAX_PROJECT_FILES} files`);
    const { contentType, size } = body.data;
    if (!ALLOWED_TYPES[contentType]) return apiError(reply, 400, "unsupported_type", "Only PDF, plain text, Markdown and CSV files are supported");
    const maxBytes = maxBytesFor(contentType, deps.config.MAX_ATTACHMENT_MB);
    if (size > maxBytes) return apiError(reply, 400, "file_too_large", `Files of this type are limited to ${Math.round(maxBytes / 1048576)} MB`);
    const attachmentId = ulid();
    const name = safeName(body.data.name);
    const upload = await deps.attachments.presignUpload(projectKnowledgeKey(p.id, attachmentId, name), contentType, 900);
    return reply.code(201).send({ id: attachmentId, name, contentType, size, upload });
  });

  app.post("/api/projects/:id/knowledge/:attachmentId", { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.attachments) return apiError(reply, 400, "attachments_disabled", "File uploads are not enabled on this server");
    const body = z.object({ name: z.string().trim().min(1).max(200) }).safeParse(req.body);
    const { attachmentId } = req.params as { id: string; attachmentId: string };
    if (!body.success || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(attachmentId)) return apiError(reply, 400, "bad_request", "Invalid request");
    const p = await load(req, reply, true);
    if (!p) return reply;
    if (p.knowledge.some((k) => k.id === attachmentId)) return publicProject(p, req.session!.userId, req.session!.roles);
    let verified;
    try {
      verified = await verifyUpload(deps.attachments, projectKnowledgeKey(p.id, attachmentId, body.data.name), attachmentId, body.data.name, deps.config.MAX_ATTACHMENT_MB);
    } catch (e) {
      if (e instanceof AttachmentProblem) return apiError(reply, 400, e.code, e.message);
      throw e;
    }
    const knowledge = [...p.knowledge, verified.meta];
    const tokens = knowledge.reduce((n, k) => n + estimateAttachmentTokens(k), 0);
    if (tokens > MAX_PROJECT_KNOWLEDGE_TOKENS) {
      await deps.attachments.deletePrefix(`projects/${p.id}/${attachmentId}/`).catch(() => undefined);
      return apiError(reply, 400, "knowledge_too_large", "The project's files would exceed what fits in one conversation. Remove a file or split the document.");
    }
    const updated = await deps.repos.projects.update(p.id, { knowledge, updatedAt: now().toISOString() });
    if (!updated) return apiError(reply, 404, "not_found", "Project not found");
    await audit(deps, req, { action: "project_knowledge_add", meta: { projectId: p.id, attachmentId, contentType: verified.meta.contentType, size: verified.meta.size } });
    return publicProject(updated, req.session!.userId, req.session!.roles);
  });

  app.delete("/api/projects/:id/knowledge/:attachmentId", { preHandler: requireAuth() }, async (req, reply) => {
    const { attachmentId } = req.params as { id: string; attachmentId: string };
    const p = await load(req, reply, true);
    if (!p) return reply;
    const remaining = p.knowledge.filter((k) => k.id !== attachmentId);
    if (remaining.length === p.knowledge.length) return apiError(reply, 404, "not_found", "File not found");
    const updated = await deps.repos.projects.update(p.id, { knowledge: remaining, updatedAt: now().toISOString() });
    if (deps.attachments) await deps.attachments.deletePrefix(`projects/${p.id}/${attachmentId}/`).catch(() => undefined);
    await audit(deps, req, { action: "project_knowledge_remove", meta: { projectId: p.id, attachmentId } });
    return updated ? publicProject(updated, req.session!.userId, req.session!.roles) : apiError(reply, 404, "not_found", "Project not found");
  });
}
