import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ulid } from "@helixona/core";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth } from "../app.js";
import { MemoryAttachmentStore } from "../attachments/store.js";
import { ALLOWED_TYPES, attachmentKey, maxBytesFor, safeName } from "../attachments/policy.js";
import { locateConversation } from "./conversations.js";
import { isSpreadsheet, readTables, SpreadsheetError } from "../attachments/sheets.js";

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
    // The conversation may be the user's own or one of a shared project they take part in.
    const located = await locateConversation(deps, req.session!, id);
    if (!located) return apiError(reply, 404, "not_found", "Conversation not found");
    const { contentType, size } = body.data;
    if (!ALLOWED_TYPES[contentType]) return apiError(reply, 400, "unsupported_type", "Only PDF, Excel (.xlsx), CSV, plain text and Markdown files are supported");
    const maxBytes = maxBytesFor(contentType, deps.config.MAX_ATTACHMENT_MB);
    if (size > maxBytes) return apiError(reply, 400, "file_too_large", `Files of this type are limited to ${Math.round(maxBytes / 1048576)} MB`);

    const attachmentId = ulid();
    const name = safeName(body.data.name);
    const upload = await deps.attachments.presignUpload(attachmentKey(id, attachmentId, name), contentType, 900);
    await audit(deps, req, { action: "attachment_upload_url", conversationId: id, meta: { attachmentId, contentType, size } });
    return reply.code(201).send({ id: attachmentId, name, contentType, size, upload });
  });

  // The rows of a spreadsheet attached to the conversation, as displayed text: the browser copies them into a
  // workbook the assistant prepares ("the original data", or the rows it selected), so no value is retyped.
  app.get("/api/conversations/:id/attachments/:attachmentId/table", { preHandler: requireAuth() }, async (req, reply) => {
    if (!deps.attachments) return apiError(reply, 400, "attachments_disabled", "File uploads are not enabled on this server");
    const { id, attachmentId } = req.params as { id: string; attachmentId: string };
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(attachmentId)) return apiError(reply, 404, "not_found", "File not found");
    const located = await locateConversation(deps, req.session!, id);
    if (!located) return apiError(reply, 404, "not_found", "Conversation not found");
    const meta = (await deps.repos.messages.list(id)).flatMap((m) => m.attachments ?? []).find((a) => a.id === attachmentId);
    if (!meta) return apiError(reply, 404, "not_found", "File not found");
    if (!isSpreadsheet(meta.contentType)) return apiError(reply, 400, "not_a_spreadsheet", `"${meta.name}" is not a spreadsheet`);
    let bytes: Buffer;
    try {
      bytes = await deps.attachments.get(meta.key);
    } catch {
      return apiError(reply, 404, "attachment_gone", `"${meta.name}" is no longer available`);
    }
    try {
      const sheets = await readTables(meta.contentType, bytes);
      await audit(deps, req, { action: "attachment_opened", conversationId: id, meta: { attachmentId, sheets: sheets.length, rows: sheets.reduce((n, t) => n + t.rows.length, 0) } });
      return { id: meta.id, name: meta.name, sheets };
    } catch (e) {
      if (e instanceof SpreadsheetError) return apiError(reply, 400, "not_a_spreadsheet", e.message);
      throw e;
    }
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
      await store.put(key, bytes, contentType);
      return reply.code(200).send({ ok: true, size: bytes.length });
    });
  }
}
