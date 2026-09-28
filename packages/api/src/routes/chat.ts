import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { estimateAttachmentTokens, estimateTokens, modelByAlias, ulid, type AttachmentMeta, type BetaContentBlockParam, type StoredMessage, type TurnEvent, type UsageSummary } from "@helixona/core";
import type { Deps } from "../deps.js";
import { attachmentKey, INLINE, MAX_PDF_PAGES, READ } from "../attachments/policy.js";
import { AttachmentProblem, checkUpload, documentBlock, inspectPdf, loadDocumentBlocks, readingBlock, type PdfInfo } from "../attachments/documents.js";
import { planDelivery } from "../attachments/planner.js";
import { DocumentReader, Semaphore, type FileReading } from "../attachments/reader.js";
import { locateConversation } from "./conversations.js";
import { requireTraining } from "./training.js";
import { apiError, audit, requireAuth, today } from "../app.js";
import { SseWriter } from "../sse.js";
import { CSP } from "../app.js";

/** A turn's claim on its conversation outlives any model timeout; it is released when the turn ends. */
const LOCK_MS = 15 * 60_000;
/** Reading large files can take longer than the claim: it is renewed while the turn runs. */
const LOCK_RENEW_MS = 5 * 60_000;
/** Above this many megabytes of new PDFs, the browser is told that the files are being checked. */
const SHOW_CHECKING_BYTES = 5 * 1024 * 1024;

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

/** A line of the list the browser shows while large files are checked and read. */
export interface FileProgress {
  id: string;
  name: string;
  pages: number | null;
  pagesDone: number;
  state: "checking" | "queued" | "reading" | "done" | "failed";
  note?: string;
}

/** Tokens a document sent whole takes in the request (a PDF page is text plus its image). */
function inlineTokens(meta: AttachmentMeta): number {
  if (meta.contentType === "application/pdf") return (meta.pages ?? Math.max(1, Math.ceil(meta.size / 100_000))) * INLINE.tokensPerPage;
  return Math.ceil(meta.size / 3.5);
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === "object" && ((e as { name?: string }).name === "AbortError" || (e as { name?: string }).name === "APIUserAbortError");
}

const EMPTY_USAGE: UsageSummary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0 };

export function registerChatRoute(app: FastifyInstance, deps: Deps): void {
  const now = deps.now ?? (() => new Date());
  const ttl = deps.config.RETENTION_DAYS * 86400;
  const limiter = new TurnRateLimiter(deps.config.RATE_LIMIT_TURNS_PER_HOUR);
  // Large PDFs are transcribed by a second model, a few pages per request (see attachments/reader.ts).
  const readerEntry = modelByAlias(deps.catalog, deps.config.READER_MODEL_ALIAS) ?? modelByAlias(deps.catalog, deps.catalog.defaultAlias) ?? deps.catalog.models[0]!;
  const reader = deps.attachments
    ? new DocumentReader({
        store: deps.attachments,
        provider: deps.provider,
        catalog: deps.catalog,
        log: deps.log,
        modelId: readerEntry.modelId,
        effort: deps.config.READER_EFFORT,
        chunkConcurrency: deps.config.READER_CONCURRENCY,
        fileConcurrency: deps.config.READER_FILE_CONCURRENCY,
        retryDelaysMs: deps.config.NODE_ENV === "test" ? [10, 10, 10] : undefined,
      })
    : null;
  // Counting the pages of new PDFs downloads them: a few at a time, across the server.
  const inspections = new Semaphore(3);

  app.post("/api/conversations/:id/messages", { preHandler: requireAuth() }, async (req, reply) => {
    if (!(await requireTraining(deps, req, reply))) return;
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
    const located = await locateConversation(deps, req.session!, id);
    if (!located) return apiError(reply, 404, "not_found", "Conversation not found");
    const { conv, key, project } = located;

    // Quick checks of the new files before the reply stream starts, so problems the user can fix are
    // plain HTTP errors. Pages are counted inside the stream: the files may be large.
    const newFiles: AttachmentMeta[] = [];
    for (const a of body.data.attachments) {
      if (newFiles.some((f) => f.id === a.id)) continue;
      try {
        newFiles.push(await checkUpload(deps.attachments!, attachmentKey(id, a.id, a.name), a.id, a.name, deps.config.MAX_ATTACHMENT_MB));
      } catch (e) {
        if (e instanceof AttachmentProblem) return apiError(reply, 400, e.code, e.message);
        throw e;
      }
    }

    // Project context: instructions become a second cached system block; knowledge files are placed at the
    // very start of the conversation so the cached prefix is shared by every conversation in the project.
    const projectUsable = project !== null;
    const knowledge = projectUsable && deps.attachments ? project.knowledge : [];
    const systemExtra = projectUsable && project.instructions.trim() ? `# Project: ${project.name}\n\n${project.instructions.trim()}` : undefined;
    const projectTokens = projectUsable && conv.messageCount === 0 ? knowledge.reduce((n, k) => n + estimateAttachmentTokens(k), 0) : 0;
    const userText = text || (newFiles.length === 1 ? "Please review the attached document." : "Please review the attached documents.");

    // One turn at a time per conversation: in a shared project two people may write at once, and the
    // messages of a turn are numbered from the history read below.
    if (!(await deps.repos.conversations.lock(key, id, new Date(now().getTime() + LOCK_MS).toISOString(), now().toISOString()))) {
      return apiError(reply, 409, "conversation_busy", "Someone else is sending a message in this conversation. Wait for the answer, then try again.");
    }
    const renew = setInterval(() => {
      void deps.repos.conversations.renew(key, id, new Date(now().getTime() + LOCK_MS).toISOString()).catch(() => undefined);
    }, LOCK_RENEW_MS);
    const release = () => {
      clearInterval(renew);
      return deps.repos.conversations.unlock(key, id).catch(() => undefined);
    };

    // A partir de aquí la respuesta es SSE: los errores de negocio viajan como evento `error`.
    reply.hijack();
    const sse = new SseWriter(reply.raw, 15_000, { "content-security-policy": CSP });
    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    const fail = async (code: string, message: string, action = "turn_error") => {
      sse.send("error", { code, message, retryable: false, partial: false });
      await audit(deps, req, { action, conversationId: id, model: conv.modelId, meta: { code } });
      await release();
      sse.end();
    };

    if (!limiter.allow(userId)) return fail("quota_exceeded", "You have exceeded the hourly message limit", "quota_exceeded");
    const day = today(now);
    const usage = await deps.repos.usage.get(userId, day);
    if (deps.config.DAILY_QUOTA_USD > 0 && (usage?.estimatedUsd ?? 0) >= deps.config.DAILY_QUOTA_USD) return fail("quota_exceeded", "You have used up today's usage quota", "quota_exceeded");

    const rawHistory = await deps.repos.messages.list(id);
    const seq = rawHistory.length;
    const userMessageId = ulid();
    const assistantMessageId = ulid();
    const started = now();
    const storedUserMessage = (createdAt: string): StoredMessage => ({ id: userMessageId, conversationId: id, seq: seq + 1, role: "user", authorId: req.session!.userId, authorName: req.session!.name, content: [{ type: "text", text: userText }], ...(newFiles.length > 0 ? { attachments: newFiles } : {}), model: null, fallbackReason: null, stopReason: null, usage: null, createdAt });
    let phase: "files" | "model" = "files";
    // What reading large files cost, request by request, and whether it was already counted.
    const readSpent: UsageSummary = { ...EMPTY_USAGE };
    let readSpentCounted = false;
    const countReading = async () => {
      if (readSpentCounted || !reader || readSpent.inputTokens + readSpent.outputTokens === 0) return;
      readSpentCounted = true;
      await deps.repos.usage.add(userId, day, reader.modelId, readSpent);
    };

    try {
      // ---- Files: count the pages of the new PDFs, decide what goes whole and what is read, read ----
      const progress = new Map<string, FileProgress>();
      const sendFiles = (state: "checking" | "reading" | "read") => sse.send("files", { phase: state, files: [...progress.values()] });
      const newPdfs = newFiles.filter((f) => f.contentType === "application/pdf");
      const showChecking = newPdfs.reduce((n, f) => n + f.size, 0) > SHOW_CHECKING_BYTES;
      if (showChecking) {
        for (const f of newPdfs) progress.set(f.id, { id: f.id, name: f.name, pages: null, pagesDone: 0, state: "checking" });
        sendFiles("checking");
      }
      const infos = new Map<string, PdfInfo>();
      await Promise.all(
        newPdfs.map(async (f) => {
          const releaseSlot = await inspections.acquire(ac.signal);
          try {
            infos.set(f.id, await inspectPdf(deps.attachments!, f.key));
          } finally {
            releaseSlot();
          }
        }),
      );
      for (const f of newPdfs) {
        f.pages = infos.get(f.id)?.pages ?? null;
        if (f.pages !== null && f.pages > MAX_PDF_PAGES) {
          return fail("too_many_pages", `"${f.name}" has ${f.pages.toLocaleString("en-US")} pages; files are limited to ${MAX_PDF_PAGES.toLocaleString("en-US")} pages each. Please split it into smaller files.`);
        }
      }

      const historyFiles = rawHistory.filter((m) => m.role === "user").flatMap((m) => m.attachments ?? []);
      const reserved = {
        bytes: knowledge.reduce((n, k) => n + k.size, 0),
        pages: knowledge.reduce((n, k) => n + (k.contentType === "application/pdf" ? (k.pages ?? 0) : 0), 0),
      };
      if (reserved.bytes > INLINE.budgetBytes) return fail("project_too_large", "This project's files are too large to send together. Remove a file from the project, then try again.");
      const plan = planDelivery([...historyFiles, ...newFiles], reserved);
      const toRead = [...historyFiles, ...newFiles].filter((f) => plan.get(f.id) === "read");

      // Transcriptions made in an earlier turn (or an earlier try) are reused as they are.
      const readings = new Map<string, FileReading>();
      const pending: AttachmentMeta[] = [];
      for (const f of toRead) {
        const cached = reader ? await reader.cached(f) : null;
        if (cached !== null) readings.set(f.id, { text: cached, pages: f.pages, failedPages: [], usage: { ...EMPTY_USAGE }, partsRead: 0, partsCached: 0, cached: true });
        else pending.push(f);
      }

      const pagesToRead = pending.reduce((n, f) => n + (f.pages ?? Math.max(1, Math.ceil(f.size / 100_000))), 0);
      if (pagesToRead > READ.maxPagesPerTurn) {
        return fail("too_many_pages", `These files have about ${pagesToRead.toLocaleString("en-US")} pages to read; up to ${READ.maxPagesPerTurn.toLocaleString("en-US")} pages can be read in one message. Send the files in two or more messages.`);
      }
      // Before anything is spent: would the conversation still fit once the new files are in?
      const newFileTokens = (estimate: (f: AttachmentMeta) => number) =>
        newFiles.reduce((n, f) => n + (plan.get(f.id) === "read" ? (readings.has(f.id) ? estimateTokens(readings.get(f.id)!.text) : estimate(f)) : inlineTokens(f)), 0);
      const contextBefore = conv.lastInputTokens + estimateTokens(userText) + projectTokens;
      if (contextBefore + newFileTokens((f) => (f.pages ?? Math.ceil(f.size / 100_000)) * READ.tokensPerPage) > deps.config.CONTEXT_LIMIT_TOKENS) {
        return fail("context_limit", "These files are too long for one conversation. Send fewer files at a time, or start a new conversation for part of them.");
      }

      if (pending.length > 0 && reader) {
        progress.clear();
        for (const f of pending) progress.set(f.id, { id: f.id, name: f.name, pages: f.pages, pagesDone: 0, state: "queued" });
        sendFiles("reading");
        let lastSent = 0;
        const results = await Promise.all(
          pending.map(async (f) => {
            const line = progress.get(f.id)!;
            const r = await reader.read(f, {
              signal: ac.signal,
              conversationId: id,
              onUsage: (u) => {
                readSpent.inputTokens += u.inputTokens;
                readSpent.outputTokens += u.outputTokens;
                readSpent.cacheReadTokens += u.cacheReadTokens;
                readSpent.cacheWriteTokens += u.cacheWriteTokens;
                readSpent.estimatedUsd += u.estimatedUsd;
              },
              onProgress: (done, total) => {
                line.state = "reading";
                line.pagesDone = done;
                if (total !== null) line.pages = total;
                const t = Date.now();
                if (t - lastSent > 300) {
                  lastSent = t;
                  sendFiles("reading");
                }
              },
            });
            if (r.pages !== null) {
              line.pages = r.pages;
              if (f.pages === null) f.pages = r.pages;
            }
            line.pagesDone = line.pages ?? line.pagesDone;
            line.state = r.failedPages.length > 0 ? "failed" : "done";
            if (r.failedPages.length > 0) line.note = `Pages ${r.failedPages.join(", ")} could not be read.`;
            sendFiles("reading");
            return [f.id, r] as const;
          }),
        );
        for (const [fid, r] of results) readings.set(fid, r);
        sendFiles("read");

        await countReading();
        const failedFiles = results.filter(([, r]) => r.failedPages.length > 0).length;
        await audit(deps, req, {
          action: "attachments_read",
          conversationId: id,
          model: reader.modelId,
          usage: { ...readSpent },
          latencyMs: now().getTime() - started.getTime(),
          meta: { files: pending.length, pages: results.reduce((n, [, r]) => n + (r.pages ?? 0), 0), partsRead: results.reduce((n, [, r]) => n + r.partsRead, 0), partsCached: results.reduce((n, [, r]) => n + r.partsCached, 0), failedFiles },
        });
      } else if (showChecking) {
        progress.clear();
        sendFiles("read");
      }

      // ---- Build the request: files whole or as their transcription, in the same order every turn ----
      const store = deps.attachments;
      const blocksFor = async (metas: AttachmentMeta[], cacheLast: boolean): Promise<BetaContentBlockParam[]> => {
        const blocks: BetaContentBlockParam[] = [];
        for (const [i, meta] of metas.entries()) {
          const cache = cacheLast && i === metas.length - 1;
          const reading = readings.get(meta.id);
          if (plan.get(meta.id) === "read") {
            blocks.push(reading ? readingBlock(meta, reading.text, reading.failedPages, cache) : { type: "text", text: `[Attachment "${meta.name}" could not be read]` });
            continue;
          }
          try {
            blocks.push(documentBlock(meta, await store!.get(meta.key), cache));
          } catch {
            blocks.push({ type: "text", text: `[Attachment "${meta.name}" is no longer available]` });
          }
        }
        return blocks;
      };
      // The most recent set of earlier files gets the cache breakpoint unless the new turn brings its own
      // (at most 4 breakpoints per request).
      const latest = [...rawHistory].reverse().find((m) => m.role === "user" && (m.attachments?.length ?? 0) > 0);
      const history: StoredMessage[] = [];
      for (const m of rawHistory) {
        if (!store || m.role !== "user" || !m.attachments?.length) {
          history.push(m);
          continue;
        }
        const blocks = await blocksFor(m.attachments, newFiles.length === 0 && m === latest);
        history.push({ ...m, content: [...blocks, ...(m.content as BetaContentBlockParam[])] });
      }
      const userContent: BetaContentBlockParam[] = [...(store ? await blocksFor(newFiles, true) : []), { type: "text", text: userText }];
      if (knowledge.length > 0 && store) {
        const docs = await loadDocumentBlocks(store, knowledge, true);
        const first = history[0];
        if (first && first.role === "user") history[0] = { ...first, content: [...docs, ...(first.content as BetaContentBlockParam[])] };
        else userContent.unshift(...docs);
      }
      const newTokens = newFileTokens(() => 0);
      if (contextBefore + newTokens > deps.config.CONTEXT_LIMIT_TOKENS) {
        return fail("context_limit", newFiles.length > 0 ? "The attached documents are too large for this conversation. Split them or start a new conversation." : "This conversation is too long; please start a new one");
      }

      // ---- The answer ----
      phase = "model";
      const emit = (ev: TurnEvent) => {
        switch (ev.type) {
          case "message_start": return sse.send("message_start", { userMessageId, assistantMessageId, model: ev.model });
          case "done": return sse.send("done", { assistantMessageId, model: ev.model, stopReason: ev.stopReason, usage: ev.usage, fallbackReason: ev.fallbackReason });
          default: { const { type, ...data } = ev; return sse.send(type, data); }
        }
      };
      const result = await deps.router.runTurn({ conversation: conv, history, userText, userContent, systemPrompt: deps.systemPrompt.text, systemExtra, signal: ac.signal, emit });
      const latencyMs = now().getTime() - started.getTime();
      if (result.ok && result.servedModel) {
        const createdAt = now().toISOString();
        const userMsg = storedUserMessage(createdAt);
        const assistantMsg: StoredMessage = { id: assistantMessageId, conversationId: id, seq: seq + 2, role: "assistant", content: result.content, model: result.servedModel, fallbackReason: result.fallbackReason, stopReason: result.stopReason, usage: result.usage, createdAt: now().toISOString() };
        await deps.repos.messages.append(userMsg, ttl);
        await deps.repos.messages.append(assistantMsg, ttl);
        await deps.repos.conversations.update(key, id, {
          messageCount: seq + 2,
          lastInputTokens: result.usage.inputTokens + result.usage.cacheReadTokens + result.usage.cacheWriteTokens + result.usage.outputTokens,
          // No pin means the conversation's own model answered: clear any earlier pin (expired or stale).
          pinnedModel: result.pin?.model ?? null,
          pinReason: result.pin?.reason ?? null,
          pinnedUntil: result.pin?.until ?? null,
        });
        await deps.repos.usage.add(userId, day, result.servedModel, result.usage);
        await audit(deps, req, { action: "turn", conversationId: id, model: result.requestedModel, servedBy: result.servedModel, fallbackReason: result.fallbackReason ?? undefined, stopReason: result.stopReason ?? undefined, usage: result.usage, latencyMs });
      } else if (result.error?.kind === "aborted") {
        // The reader pressed Stop or left the page: the message they sent and whatever was answered stay in
        // the conversation (the answer marked as stopped) instead of vanishing on the next load.
        const partialText = result.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        await deps.repos.messages.append(storedUserMessage(now().toISOString()), ttl);
        let messageCount = seq + 1;
        if (partialText) {
          await deps.repos.messages.append({ id: assistantMessageId, conversationId: id, seq: seq + 2, role: "assistant", content: result.content, model: result.servedModel ?? conv.modelId, fallbackReason: result.fallbackReason, stopReason: "stopped", usage: null, createdAt: now().toISOString() }, ttl);
          messageCount = seq + 2;
        }
        await deps.repos.conversations.update(key, id, { messageCount, lastInputTokens: contextBefore + newTokens + estimateTokens(partialText) - projectTokens });
        await audit(deps, req, { action: "turn_stopped", conversationId: id, model: result.requestedModel, servedBy: result.servedModel ?? undefined, latencyMs, meta: { partial: partialText.length > 0 } });
      } else if (result.stopReason === "refusal") {
        await audit(deps, req, { action: "turn", conversationId: id, model: result.requestedModel, refusalCategory: result.refusalCategory, stopReason: "refusal", latencyMs });
      } else {
        await audit(deps, req, { action: "turn_error", conversationId: id, model: result.requestedModel, latencyMs, meta: { errorClass: result.error?.errorClass ?? "unknown", kind: result.error?.kind ?? "unknown", partial: result.partial } });
      }
    } catch (e) {
      if (phase === "files" && (ac.signal.aborted || isAbort(e))) {
        // Stopped (or the page was left) while the files were being read: the message stays, like any
        // stopped turn; the parts already transcribed are kept for the next try, and what they cost counts.
        await countReading().catch(() => undefined);
        await deps.repos.messages.append(storedUserMessage(now().toISOString()), ttl).catch(() => undefined);
        await deps.repos.conversations.update(key, id, { messageCount: seq + 1 }).catch(() => undefined);
        await audit(deps, req, { action: "turn_stopped", conversationId: id, model: conv.modelId, ...(readSpentCounted ? { usage: { ...readSpent } } : {}), latencyMs: now().getTime() - started.getTime(), meta: { partial: false, phase: "files" } }).catch(() => undefined);
      } else {
        await countReading().catch(() => undefined);
        deps.log.error("turn_unhandled", { conversationId: id, errorClass: e instanceof Error ? e.name : "unknown", requestId: req.requestId });
        sse.send("error", { code: "internal", message: "The request could not be completed", retryable: true, partial: false });
      }
    } finally {
      await release();
      sse.end();
    }
  });
}
