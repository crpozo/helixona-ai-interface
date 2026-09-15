import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ulid } from "@helixona/core";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth } from "../app.js";
import { MemoryAttachmentStore } from "../attachments/store.js";
import { ALLOWED_TYPES, attachmentKey, maxBytesFor, safeName } from "../attachments/policy.js";

/**
 * Uploads: the client asks for a presigned URL, PUTs the file straight to storage, then references the
 * attachment id when it sends the message. Nothing is trusted until the chat route verifies the object.
 */
export function registerAttachmentRoutes(app: FastifyInstance, deps: Deps): void {
  app.post("/api/conversations/:id/attachments", { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.attachments) return apiError(reply, 400, "attachments_disabled", "File uploads are not enabled on this server");
    const { id } = req.params as { id: string };
    const body = z
      .object({ name: z.string().trim().min(1).max(200), size: z.number().int().positive(), contentType: z.string().min(1).max(100) })
      .safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const conv = await deps.repos.conversations.get(req.session!.userId, id);
    if (!conv) return apiError(reply, 404, "not_found", "Conversation not found");
    const { contentType, size } = body.data;
    if (!ALLOWED_TYPES[contentType]) return apiError(reply, 400, "unsupported_type", "Only PDF, plain text, Markdown and CSV files are supported");
    const maxBytes = maxBytesFor(contentType, deps.config.MAX_ATTACHMENT_MB);
    if (size > maxBytes) return apiError(reply, 400, "file_too_large", `Files of this type are limited to ${Math.round(maxBytes / 1048576)} MB`);

    const attachmentId = ulid();
    const name = safeName(body.data.name);
    const upload = await deps.attachments.presignUpload(attachmentKey(id, attachmentId, name), contentType, 900);
    await audit(deps, req, { action: "attachment_upload_url", conversationId: id, meta: { attachmentId, contentType, size } });
    return reply.code(201).send({ id: attachmentId, name, contentType, size, upload });
  });

  // Development and tests only: receives the bytes the browser would otherwise PUT to S3.
  if (deps.attachments instanceof MemoryAttachmentStore && deps.config.NODE_ENV !== "production") {
    const store = deps.attachments;
    const limit = Math.ceil(deps.config.MAX_ATTACHMENT_MB * 1024 * 1024);
    app.addContentTypeParser(Object.keys(ALLOWED_TYPES), { parseAs: "buffer", bodyLimit: limit }, (_req, body, done) => done(null, body));
    app.put("/api/dev/upload/*", { bodyLimit: limit }, async (req, reply) => {
      const key = ((req.params as Record<string, string>)["*"] ?? "").split("/").map(decodeURIComponent).join("/");
      const contentType = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0]!.trim();
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : "");
      store.put(key, bytes, contentType);
      return reply.code(200).send({ ok: true, size: bytes.length });
    });
  }
}
