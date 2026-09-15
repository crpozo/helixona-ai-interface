import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { estimateTokens, ulid, type StoredMessage, type TurnEvent, estimateAttachmentTokens, type AttachmentMeta, type BetaContentBlockParam } from "@helixona/core";
import type { Deps } from "../deps.js";
import type { AttachmentStore } from "../attachments/store.js";
import { ALLOWED_TYPES, attachmentKey, MAX_PDF_PAGES, maxBytesFor, safeName } from "../attachments/policy.js";
import { PDFDocument } from "pdf-lib";
import { apiError, audit, requireAuth, today } from "../app.js";
import { SseWriter } from "../sse.js";
import { CSP } from "../app.js";

/** Límite simple por usuario: N turnos por hora (en memoria; suficiente para 1-2 tareas). */
class TurnRateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private readonly perHour: number, private readonly now: () => number = () => Date.now()) {}
  allow(userId: string): boolean {
    const t = this.now();
    const list = (this.hits.get(userId) ?? []).filter((x) => t - x < 3_600_000);
    if (list.length >= this.perHour) { this.hits.set(userId, list); return false; }
    list.push(t); this.hits.set(userId, list); return true;
  }
}

async function pdfPageCount(bytes: Buffer): Promise<number | null> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    return null; // unreadable by pdf-lib: let the model try, the size cap still applies
  }
}

/** PDFs go to the model natively (base64); text files as plain-text documents. `cache` marks a prompt-cache breakpoint. */
function documentBlock(meta: AttachmentMeta, bytes: Buffer, cache: boolean): BetaContentBlockParam {
  const block =
    meta.contentType === "application/pdf"
      ? { type: "document" as const, title: meta.name, source: { type: "base64" as const, media_type: "application/pdf" as const, data: bytes.toString("base64") } }
      : { type: "document" as const, title: meta.name, source: { type: "text" as const, media_type: "text/plain" as const, data: bytes.toString("utf8") } };
  return (cache ? { ...block, cache_control: { type: "ephemeral", ttl: "1h" } } : block) as BetaContentBlockParam;
}

/**
 * Rebuilds the document blocks of earlier user turns from storage. The most recent set gets the cache
 * breakpoint unless the new turn brings its own attachments (at most 4 breakpoints per request).
 */
async function hydrateHistory(history: StoredMessage[], store: AttachmentStore | null, cacheLatest: boolean): Promise<StoredMessage[]> {
  if (!store) return history;
  const latest = [...history].reverse().find((m) => m.role === "user" && (m.attachments?.length ?? 0) > 0);
  const out: StoredMessage[] = [];
  for (const m of history) {
    if (m.role !== "user" || !m.attachments?.length) { out.push(m); continue; }
    const blocks: BetaContentBlockParam[] = [];
    for (const [i, meta] of m.attachments.entries()) {
      try {
        blocks.push(documentBlock(meta, await store.get(meta.key), cacheLatest && m === latest && i === m.attachments.length - 1));
      } catch {
        blocks.push({ type: "text", text: `[Attachment "${meta.name}" is no longer available]` });
      }
    }
    out.push({ ...m, content: [...blocks, ...(m.content as BetaContentBlockParam[])] });
  }
  return out;
}

export function registerChatRoute(app: FastifyInstance, deps: Deps): void {
  const now = deps.now ?? (() => new Date());
  const ttl = deps.config.RETENTION_DAYS * 86400;
  const limiter = new TurnRateLimiter(deps.config.RATE_LIMIT_TURNS_PER_HOUR);

  app.post("/api/conversations/:id/messages", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.session!.userId;
    const body = z
      .object({
        text: z.string().max(deps.config.MAX_MESSAGE_CHARS).default(""),
        attachments: z
          .array(z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), name: z.string().min(1).max(200) }))
          .max(deps.config.MAX_ATTACHMENTS_PER_MESSAGE)
          .default([]),
      })
      .safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const text = body.data.text.trim();
    if (!text && body.data.attachments.length === 0) return apiError(reply, 400, "bad_request", "Invalid request");
    if (body.data.attachments.length > 0 && !deps.attachments) return apiError(reply, 400, "attachments_disabled", "File uploads are not enabled on this server");
    const conv = await deps.repos.conversations.get(userId, id);
    if (!conv) return apiError(reply, 404, "not_found", "Conversation not found");

    // Attached files: verify each upload, read it and build its document block before the SSE starts, so
    // validation problems are plain HTTP errors. Only metadata is stored; the bytes stay in object storage.
    const attached: { meta: AttachmentMeta; bytes: Buffer }[] = [];
    for (const a of body.data.attachments) {
      const name = safeName(a.name);
      const key = attachmentKey(id, a.id, name);
      const head = await deps.attachments!.head(key);
      if (!head) return apiError(reply, 400, "attachment_missing", `The file "${name}" was not uploaded`);
      const contentType = head.contentType && ALLOWED_TYPES[head.contentType] ? head.contentType : name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain";
      if (head.size > maxBytesFor(contentType, deps.config.MAX_ATTACHMENT_MB)) return apiError(reply, 400, "file_too_large", `The file "${name}" is too large`);
      const bytes = await deps.attachments!.get(key);
      const pages = contentType === "application/pdf" ? await pdfPageCount(bytes) : null;
      if (pages !== null && pages > MAX_PDF_PAGES) return apiError(reply, 400, "too_many_pages", `"${name}" has ${pages} pages; PDFs are limited to ${MAX_PDF_PAGES} pages each. Please split the document.`);
      attached.push({ meta: { id: a.id, name, contentType, size: head.size, pages, key }, bytes });
    }
    const userText = text || (attached.length === 1 ? "Please review the attached document." : "Please review the attached documents.");
    const userContent: BetaContentBlockParam[] = [
      ...attached.map((a, i) => documentBlock(a.meta, a.bytes, i === attached.length - 1)),
      { type: "text", text: userText },
    ];

    // A partir de aquí la respuesta es SSE: los errores de negocio viajan como evento `error`.
    reply.hijack();
    const sse = new SseWriter(reply.raw, 15_000, { "content-security-policy": CSP });
    const fail = async (code: string, message: string, action = "turn_error") => {
      sse.send("error", { code, message, retryable: false, partial: false });
      await audit(deps, req, { action, conversationId: id, model: conv.modelId, meta: { code } });
      sse.end();
    };

    if (!limiter.allow(userId)) return fail("quota_exceeded", "You have exceeded the hourly message limit", "quota_exceeded");
    const day = today(now);
    const usage = await deps.repos.usage.get(userId, day);
    if (deps.config.DAILY_QUOTA_USD > 0 && (usage?.estimatedUsd ?? 0) >= deps.config.DAILY_QUOTA_USD) return fail("quota_exceeded", "You have used up today's usage quota", "quota_exceeded");
    const attachedTokens = attached.reduce((n, a) => n + estimateAttachmentTokens(a.meta), 0);
    if (conv.lastInputTokens + estimateTokens(userText) + attachedTokens > deps.config.CONTEXT_LIMIT_TOKENS) {
      return fail("context_limit", attached.length > 0 ? "The attached documents are too large for this conversation. Split them or start a new conversation." : "This conversation is too long; please start a new one");
    }

    // The API is stateless: earlier attachments are re-read from storage and re-sent on every turn (cached).
    const history = await hydrateHistory(await deps.repos.messages.list(id), deps.attachments, attached.length === 0);
    const userMessageId = ulid();
    const assistantMessageId = ulid();
    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    const started = now();

    const emit = (ev: TurnEvent) => {
      switch (ev.type) {
        case "message_start": return sse.send("message_start", { userMessageId, assistantMessageId, model: ev.model });
        case "done": return sse.send("done", { assistantMessageId, model: ev.model, stopReason: ev.stopReason, usage: ev.usage, fallbackReason: ev.fallbackReason });
        default: { const { type, ...data } = ev; return sse.send(type, data); }
      }
    };

    try {
      const result = await deps.router.runTurn({ conversation: conv, history, userText, userContent, systemPrompt: deps.systemPrompt.text, signal: ac.signal, emit });
      const latencyMs = now().getTime() - started.getTime();
      if (result.ok && result.servedModel) {
        const seq = history.length;
        const createdAt = now().toISOString();
        const userMsg: StoredMessage = { id: userMessageId, conversationId: id, seq: seq + 1, role: "user", content: [{ type: "text", text: userText }], ...(attached.length > 0 ? { attachments: attached.map((a) => a.meta) } : {}), model: null, fallbackReason: null, stopReason: null, usage: null, createdAt };
        const assistantMsg: StoredMessage = { id: assistantMessageId, conversationId: id, seq: seq + 2, role: "assistant", content: result.content, model: result.servedModel, fallbackReason: result.fallbackReason, stopReason: result.stopReason, usage: result.usage, createdAt: now().toISOString() };
        await deps.repos.messages.append(userMsg, ttl);
        await deps.repos.messages.append(assistantMsg, ttl);
        await deps.repos.conversations.update(userId, id, {
          messageCount: seq + 2,
          lastInputTokens: result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens + result.usage.outputTokens,
          ...(result.pin ? { pinnedModel: result.pin.model, pinReason: result.pin.reason, pinnedUntil: result.pin.until } : {}),
        });
        await deps.repos.usage.add(userId, day, result.servedModel, result.usage);
        await audit(deps, req, { action: "turn", conversationId: id, model: result.requestedModel, servedBy: result.servedModel, fallbackReason: result.fallbackReason ?? undefined, stopReason: result.stopReason ?? undefined, usage: result.usage, latencyMs });
      } else if (result.stopReason === "refusal") {
        await audit(deps, req, { action: "turn", conversationId: id, model: result.requestedModel, refusalCategory: result.refusalCategory, stopReason: "refusal", latencyMs });
      } else {
        await audit(deps, req, { action: "turn_error", conversationId: id, model: result.requestedModel, latencyMs, meta: { errorClass: result.error?.errorClass ?? "unknown", kind: result.error?.kind ?? "unknown", partial: result.partial } });
      }
    } catch (e) {
      deps.log.error("turn_unhandled", { conversationId: id, errorClass: e instanceof Error ? e.name : "unknown", requestId: req.requestId });
      sse.send("error", { code: "internal", message: "The request could not be completed", retryable: true, partial: false });
    } finally {
      sse.end();
    }
  });
}
