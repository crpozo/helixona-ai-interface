import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { estimateTokens, ulid, type StoredMessage, type TurnEvent } from "@helixona/core";
import type { Deps } from "../deps.js";
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

export function registerChatRoute(app: FastifyInstance, deps: Deps): void {
  const now = deps.now ?? (() => new Date());
  const ttl = deps.config.RETENTION_DAYS * 86400;
  const limiter = new TurnRateLimiter(deps.config.RATE_LIMIT_TURNS_PER_HOUR);

  app.post("/api/conversations/:id/messages", { preHandler: requireAuth() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const userId = req.session!.userId;
    const body = z.object({ text: z.string().min(1).max(deps.config.MAX_MESSAGE_CHARS) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const conv = await deps.repos.conversations.get(userId, id);
    if (!conv) return apiError(reply, 404, "not_found", "Conversation not found");

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
    const text = body.data.text;
    if (conv.lastInputTokens + estimateTokens(text) > deps.config.CONTEXT_LIMIT_TOKENS) return fail("context_limit", "This conversation is too long; please start a new one");

    const history = await deps.repos.messages.list(id);
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
      const result = await deps.router.runTurn({ conversation: conv, history, userText: text, systemPrompt: deps.systemPrompt.text, signal: ac.signal, emit });
      const latencyMs = now().getTime() - started.getTime();
      if (result.ok && result.servedModel) {
        const seq = history.length;
        const createdAt = now().toISOString();
        const userMsg: StoredMessage = { id: userMessageId, conversationId: id, seq: seq + 1, role: "user", content: [{ type: "text", text }], model: null, fallbackReason: null, stopReason: null, usage: null, createdAt };
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
