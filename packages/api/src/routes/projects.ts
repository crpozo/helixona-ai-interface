import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { estimateAttachmentTokens, ulid, type Project, type ProjectMember, type ProjectVisibility } from "@helixona/core";
import type { Deps } from "../deps.js";
import type { Session } from "../repos/types.js";
import { apiError, audit, requireAuth } from "../app.js";
import { ALLOWED_TYPES, MAX_PROJECT_FILES, MAX_PROJECT_KNOWLEDGE_TOKENS, maxBytesFor, projectKnowledgeKey, safeName } from "../attachments/policy.js";
import { AttachmentProblem, verifyUpload } from "../attachments/documents.js";

/**
 * Projects work like Claude.ai projects: instructions plus knowledge files that every conversation
 * inside the project receives. Three kinds:
 *  - `private`: the owner's alone.
 *  - `shared`: the owner plus chosen members. Its conversations belong to the project (they are
 *    stored under the project's own partition), so every member sees and continues the same chats.
 *  - `clinic`: everyone may use its instructions and files; each person's chats stay their own.
 */
export const MAX_MEMBERS = 50;

/** Partition under which the conversations of a shared project are stored. */
export function projectPartition(projectId: string): string {
  return `project:${projectId}`;
}

export function isMember(p: Project, userId: string): boolean {
  return p.ownerId === userId || p.members.some((m) => m.id === userId);
}
export function canReadProject(p: Project, userId: string): boolean {
  return p.ownerId === userId || p.visibility === "clinic" || (p.visibility === "shared" && isMember(p, userId));
}
/** Instructions, files, name and description: the owner, administrators and, in a shared project, its members. */
export function canEditProject(p: Project, userId: string, roles: string[]): boolean {
  return p.ownerId === userId || roles.includes("admin") || (p.visibility === "shared" && isMember(p, userId));
}
/** Who sees the project (visibility and members) and its deletion: the owner or an administrator. */
export function canManageProject(p: Project, userId: string, roles: string[]): boolean {
  return p.ownerId === userId || roles.includes("admin");
}
/** The shared projects a person takes part in: where their conversations live besides their own. */
export async function sharedProjectsFor(deps: Deps, userId: string): Promise<Project[]> {
  return (await deps.repos.projects.list()).filter((p) => p.visibility === "shared" && isMember(p, userId));
}

function publicProject(p: Project, userId: string, roles: string[]) {
  return {
    id: p.id,
    ownerId: p.ownerId,
    ownerName: p.ownerName ?? "",
    name: p.name,
    description: p.description,
    instructions: p.instructions,
    visibility: p.visibility,
    members: p.members,
    knowledge: p.knowledge.map(({ key: _k, ...meta }) => meta),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    canEdit: canEditProject(p, userId, roles),
    canManage: canManageProject(p, userId, roles),
  };
}

const Name = z.string().trim().min(1).max(80);
const Description = z.string().trim().max(300);
const Instructions = z.string().max(20_000);
const Visibility = z.enum(["private", "shared", "clinic"]);

/**
 * Conversations follow the project's kind: a shared project's live under the project, where every
 * member finds them; otherwise each one lives with the person who started it. Returns how many moved.
 */
async function rehomeConversations(deps: Deps, p: Project, to: ProjectVisibility, actor: Session): Promise<number> {
  const repo = deps.repos.conversations;
  let moved = 0;
  if (to === "shared" && p.visibility !== "shared") {
    // The owner's conversations in the project become the team's.
    const ownerName = actor.userId === p.ownerId ? actor.name : ((await deps.directory.list()).find((u) => u.id === p.ownerId)?.name ?? "");
    for (const c of (await repo.list(p.ownerId)).filter((c) => c.projectId === p.id)) {
      if (await repo.move(p.ownerId, c.id, projectPartition(p.id), { createdBy: c.createdBy ?? p.ownerId, createdByName: c.createdByName ?? ownerName })) moved++;
    }
  } else if (to !== "shared" && p.visibility === "shared") {
    // Each conversation goes back to whoever started it; a member's leaves the project.
    for (const c of await repo.list(projectPartition(p.id))) {
      const home = c.createdBy ?? p.ownerId;
      if (await repo.move(projectPartition(p.id), c.id, home, home === p.ownerId ? {} : { projectId: null })) moved++;
    }
  }
  return moved;
}

export function registerProjectRoutes(app: FastifyInstance, deps: Deps): void {
  const now = deps.now ?? (() => new Date());

  const load = async (req: FastifyRequest, reply: FastifyReply, level: "read" | "edit" | "manage"): Promise<Project | null> => {
    const { id } = req.params as { id: string };
    const s = req.session!;
    const p = await deps.repos.projects.get(id);
    if (!p || !canReadProject(p, s.userId)) {
      await apiError(reply, 404, "not_found", "Project not found");
      return null;
    }
    if (level === "edit" && !canEditProject(p, s.userId, s.roles)) {
      await apiError(reply, 403, "forbidden", "Only the project owner, its members or an administrator can change this project");
      return null;
    }
    if (level === "manage" && !canManageProject(p, s.userId, s.roles)) {
      await apiError(reply, 403, "forbidden", "Only the project owner or an administrator can do this");
      return null;
    }
    return p;
  };
  const view = (p: Project, req: FastifyRequest) => publicProject(p, req.session!.userId, req.session!.roles);

  app.get("/api/projects", { preHandler: requireAuth() }, async (req) => {
    const all = await deps.repos.projects.list();
    const s = req.session!;
    return { items: all.filter((p) => canReadProject(p, s.userId)).sort((a, b) => a.name.localeCompare(b.name)).map((p) => publicProject(p, s.userId, s.roles)) };
  });

  app.post("/api/projects", { preHandler: requireAuth() }, async (req, reply) => {
    const body = z.object({ name: Name, description: Description.default(""), instructions: Instructions.default(""), visibility: Visibility.default("private") }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const t = now().toISOString();
    const p: Project = { id: ulid(), ownerId: req.session!.userId, ownerName: req.session!.name, ...body.data, members: [], knowledge: [], createdAt: t, updatedAt: t };
    await deps.repos.projects.create(p);
    await audit(deps, req, { action: "project_create", meta: { projectId: p.id, visibility: p.visibility } });
    return reply.code(201).send(view(p, req));
  });

  app.get("/api/projects/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const p = await load(req, reply, "read");
    if (!p) return reply;
    return view(p, req);
  });

  app.patch("/api/projects/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const body = z.object({ name: Name.optional(), description: Description.optional(), instructions: Instructions.optional(), visibility: Visibility.optional() }).safeParse(req.body);
    if (!body.success || Object.keys(body.data).length === 0) return apiError(reply, 400, "bad_request", "Invalid request");
    const p = await load(req, reply, "edit");
    if (!p) return reply;
    const s = req.session!;
    let moved = 0;
    if (body.data.visibility !== undefined && body.data.visibility !== p.visibility) {
      if (!canManageProject(p, s.userId, s.roles)) return apiError(reply, 403, "forbidden", "Only the project owner or an administrator can change who sees this project");
      moved = await rehomeConversations(deps, p, body.data.visibility, s);
    }
    const updated = await deps.repos.projects.update(p.id, { ...body.data, updatedAt: now().toISOString() });
    if (!updated) return apiError(reply, 404, "not_found", "Project not found");
    await audit(deps, req, { action: "project_update", meta: { projectId: p.id, fields: Object.keys(body.data).join(","), ...(body.data.visibility ? { visibility: body.data.visibility, conversationsMoved: moved } : {}) } });
    return view(updated, req);
  });

  app.delete("/api/projects/:id", { preHandler: requireAuth() }, async (req, reply) => {
    const p = await load(req, reply, "manage");
    if (!p) return reply;
    await deps.repos.projects.delete(p.id);
    // Conversations keep their history but leave the project: a shared project's go back to whoever started them.
    const repo = deps.repos.conversations;
    if (p.visibility === "shared") {
      for (const c of await repo.list(projectPartition(p.id))) await repo.move(projectPartition(p.id), c.id, c.createdBy ?? p.ownerId, { projectId: null });
    } else {
      for (const c of (await repo.list(p.ownerId)).filter((c) => c.projectId === p.id)) await repo.update(p.ownerId, c.id, { projectId: null, updatedAt: c.updatedAt });
    }
    if (deps.attachments) await deps.attachments.deletePrefix(`projects/${p.id}/`).catch(() => deps.log.warn("project_knowledge_delete_failed", { projectId: p.id }));
    await audit(deps, req, { action: "project_delete", meta: { projectId: p.id, visibility: p.visibility } });
    return reply.code(204).send();
  });

  // ---- Members of a shared project (owner or administrator) ----
  app.post("/api/projects/:id/members", { preHandler: requireAuth() }, async (req, reply) => {
    const body = z.object({ userId: z.string().trim().min(1).max(120) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const p = await load(req, reply, "manage");
    if (!p) return reply;
    if (p.visibility !== "shared") return apiError(reply, 400, "not_shared", "Set the project to “Shared with chosen people” first");
    if (body.data.userId === p.ownerId) return apiError(reply, 400, "bad_request", "The owner is already part of the project");
    if (p.members.some((m) => m.id === body.data.userId)) return view(p, req);
    if (p.members.length >= MAX_MEMBERS) return apiError(reply, 400, "too_many_members", `A project can be shared with up to ${MAX_MEMBERS} people`);
    const user = (await deps.directory.list()).find((u) => u.id === body.data.userId && u.enabled);
    if (!user) return apiError(reply, 404, "user_not_found", "That account was not found or is disabled");
    const member: ProjectMember = { id: user.id, name: user.name, email: user.email, addedAt: now().toISOString() };
    const updated = await deps.repos.projects.update(p.id, { members: [...p.members, member], updatedAt: now().toISOString() });
    if (!updated) return apiError(reply, 404, "not_found", "Project not found");
    await audit(deps, req, { action: "project_member_add", meta: { projectId: p.id, memberId: member.id } });
    return view(updated, req);
  });

  app.delete("/api/projects/:id/members/:userId", { preHandler: requireAuth() }, async (req, reply) => {
    const { userId } = req.params as { id: string; userId: string };
    const p = await load(req, reply, "manage");
    if (!p) return reply;
    const remaining = p.members.filter((m) => m.id !== userId);
    if (remaining.length === p.members.length) return apiError(reply, 404, "not_found", "That person is not in the project");
    const updated = await deps.repos.projects.update(p.id, { members: remaining, updatedAt: now().toISOString() });
    if (!updated) return apiError(reply, 404, "not_found", "Project not found");
    await audit(deps, req, { action: "project_member_remove", meta: { projectId: p.id, memberId: userId } });
    return view(updated, req);
  });

  // ---- Knowledge files: presign, then register once the browser has uploaded ----
  app.post("/api/projects/:id/knowledge", { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.attachments) return apiError(reply, 400, "attachments_disabled", "File uploads are not enabled on this server");
    const body = z.object({ name: z.string().trim().min(1).max(200), size: z.number().int().positive(), contentType: z.string().min(1).max(100) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const p = await load(req, reply, "edit");
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
    const p = await load(req, reply, "edit");
    if (!p) return reply;
    if (p.knowledge.some((k) => k.id === attachmentId)) return view(p, req);
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
    return view(updated, req);
  });

  app.delete("/api/projects/:id/knowledge/:attachmentId", { preHandler: requireAuth() }, async (req, reply) => {
    const { attachmentId } = req.params as { id: string; attachmentId: string };
    const p = await load(req, reply, "edit");
    if (!p) return reply;
    const remaining = p.knowledge.filter((k) => k.id !== attachmentId);
    if (remaining.length === p.knowledge.length) return apiError(reply, 404, "not_found", "File not found");
    const updated = await deps.repos.projects.update(p.id, { knowledge: remaining, updatedAt: now().toISOString() });
    if (deps.attachments) await deps.attachments.deletePrefix(`projects/${p.id}/${attachmentId}/`).catch(() => undefined);
    await audit(deps, req, { action: "project_knowledge_remove", meta: { projectId: p.id, attachmentId } });
    return updated ? view(updated, req) : apiError(reply, 404, "not_found", "Project not found");
  });
}
