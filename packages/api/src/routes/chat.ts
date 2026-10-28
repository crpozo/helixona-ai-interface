import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { currentModelId, estimateAttachmentTokens, estimateTokens, estimateUsd, ulid, withoutRounds, type AttachmentMeta, type BetaContentBlockParam, type StoredMessage, type ToolRound, type TurnEvent, type UsageSummary } from "@helixona/core";
import type { Deps } from "../deps.js";
import { attachmentKey, INLINE, MAX_PDF_PAGES, READ, sheetCharBudget } from "../attachments/policy.js";
import { AttachmentProblem, checkUpload, contentBlock, inspectPdf, readingBlock, type PdfInfo } from "../attachments/documents.js";
import { knowledgeTokens, planDelivery, planKnowledge } from "../attachments/planner.js";
import { CombinedTools } from "../attachments/library.js";
import { Semaphore, type FileReading } from "../attachments/reader.js";
import { isZipType, ZipTools } from "../attachments/zips.js";
import { locateConversation } from "./conversations.js";
import { requireTraining } from "./training.js";
import { apiError, audit, requireAuth, today } from "../app.js";
import { SseWriter } from "../sse.js";
import { CSP } from "../app.js";

/**
 * A turn's claim on its conversation. It is renewed while the turn runs and released when it ends; kept
 * short so that a container that dies mid-turn (a deploy, a crash) frees the conversation within minutes.
 */
const LOCK_MS = 3 * 60_000;
const LOCK_RENEW_MS = 60_000;

/** The turns running in this process, so a restart can let them finish or hand them back to the person. */
const activeTurns = new Set<{ restart: () => void }>();
export function registerTurn(turn: { restart: () => void }): () => void {
  activeTurns.add(turn);
  return () => activeTurns.delete(turn);
}
export function activeTurnCount(): number {
  return activeTurns.size;
}
/**
 * On SIGTERM: wait up to `graceMs` for the turns in flight to finish; the ones still running are then
 * told the server is restarting (the client sends the message again on the new container) and aborted.
 */
export async function drainTurns(graceMs: number, now: () => number = Date.now): Promise<number> {
  const until = now() + graceMs;
  while (activeTurns.size > 0 && now() < until) await new Promise((r) => setTimeout(r, 250));
  const left = activeTurns.size;
  for (const t of [...activeTurns]) t.restart();
  if (left > 0) await new Promise((r) => setTimeout(r, 1_000));
  return left;
}
/** Above this many megabytes of new PDFs, the browser is told that the files are being checked. */
const SHOW_CHECKING_BYTES = 5 * 1024 * 1024;
/**
 * Turns that used tools whose rounds (what was read) travel with the next requests. Older tool turns
 * keep their answer only: the model reads a file again if it needs it, instead of every earlier
 * reading growing the conversation.
 */
const TOOL_TURNS_REPLAYED = 2;

/** Where the rounds of a turn that used tools are kept: under the conversation, with its retention. */
function toolsKey(conversationId: string, assistantMessageId: string): string {
  return `conversations/${conversationId}/tools/${assistantMessageId}.json`;
}

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
  return estimateAttachmentTokens(meta);
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === "object" && ((e as { name?: string }).name === "AbortError" || (e as { name?: string }).name === "APIUserAbortError");
}

const EMPTY_USAGE: UsageSummary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0 };

/** The opaque title a conversation starts with ("Conversation Oct 27, 03:20 PM"). */
const DEFAULT_TITLE = /^Conversation [A-Z][a-z]{2} \d{1,2}, \d{2}:\d{2} [AP]M$/;
const TITLE_SYSTEM =
  "You name chats. Reply with a title of three to six words for a chat that starts with the message you are given: the topic, in the message's language, no quotes, no final period. Never include a person's name or initials, a date of birth, an age, a member, claim, account or phone number, an address, or anything else that could identify a patient; name the kind of document or question instead (\"Dental EOB out-of-pocket costs\"). Reply with the title only.";

/** A short topic title for a new conversation, from its first message, by the cheapest model; "" when it cannot be had. */
async function topicTitle(deps: Deps, text: string, signal: AbortSignal, onUsage: (model: string, u: UsageSummary) => void): Promise<string> {
  const cheapest = [...deps.catalog.models].sort((a, b) => a.costFactor - b.costFactor)[0];
  if (!cheapest || !text.trim()) return "";
  try {
    const handle = deps.provider.stream({ model: cheapest.modelId, maxTokens: 40, effort: "low", system: [{ type: "text", text: TITLE_SYSTEM }], messages: [{ role: "user", content: [{ type: "text", text: text.slice(0, 2_000) }] }] }, { signal, conversationId: "title" });
    for await (const _ev of handle) {
      // the title is taken from the final message
    }
    const msg = await handle.finalMessage();
    const spent = { inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0, cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0, cacheWriteTokens: msg.usage?.cache_creation_input_tokens ?? 0 };
    onUsage(cheapest.modelId, { ...spent, estimatedUsd: estimateUsd(deps.catalog, cheapest.modelId, spent) });
    if (msg.stop_reason === "refusal") return "";
    const raw = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
    const title = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
    return title.replace(/^["'“”‘’#*\s]+|["'“”‘’.*\s]+$/g, "").slice(0, 60);
  } catch {
    return "";
  }
}

export function registerChatRoute(app: FastifyInstance, deps: Deps): void {
  const now = deps.now ?? (() => new Date());
  const ttl = deps.config.RETENTION_DAYS * 86400;
  // A spreadsheet's rows are cut to this many characters: the model reads a part and a column
  // summary, and the browser computes references over every row. One file never fills the conversation.
  const sheetChars = Math.min(deps.config.SHEET_MODEL_CHARS, sheetCharBudget(deps.config.CONTEXT_LIMIT_TOKENS));
  const limiter = new TurnRateLimiter(deps.config.RATE_LIMIT_TURNS_PER_HOUR);
  // Large PDFs are transcribed by a second model, a few pages per request (see attachments/reader.ts; set up in app.ts).
  const reader = deps.reader ?? null;
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
    // Messages of an archived conversation (an imported backup) do not expire either.
    const ttl = conv.archived ? null : deps.config.RETENTION_DAYS * 86400;
    // A conversation follows its alias: one started on an earlier model moves to the newest one.
    const latestModel = currentModelId(deps.catalog, conv.modelAlias, conv.modelId);
    if (latestModel !== conv.modelId) {
      await deps.repos.conversations.update(key, id, { modelId: latestModel });
      conv.modelId = latestModel;
    }

    // Quick checks of the new files before the reply stream starts, so problems the user can fix are
    // plain HTTP errors. Pages are counted inside the stream: the files may be large.
    const newFiles: AttachmentMeta[] = [];
    for (const a of body.data.attachments) {
      if (newFiles.some((f) => f.id === a.id)) continue;
      try {
        newFiles.push(await checkUpload(deps.attachments!, attachmentKey(id, a.id, a.name), a.id, a.name, deps.config.MAX_ATTACHMENT_MB, sheetChars));
      } catch (e) {
        if (e instanceof AttachmentProblem) return apiError(reply, 400, e.code, e.message);
        throw e;
      }
    }

    // Project context: instructions become a second cached system block; knowledge files are placed at the
    // very start of the conversation so the cached prefix is shared by every conversation in the project.
    const projectUsable = project !== null;
    const allKnowledge = projectUsable && deps.attachments ? project.knowledge : [];
    // Files that travel with every message, and the library (on request, through tools).
    const modes = planKnowledge(allKnowledge);
    const knowledge = allKnowledge.filter((k) => modes.get(k.id) === "whole");
    const libraryFiles = allKnowledge.filter((k) => modes.get(k.id) === "library");
    if (projectUsable && libraryFiles.length > 0) deps.library?.ensureAll(project); // a reading interrupted by a restart resumes
    const systemExtra = projectUsable && project.instructions.trim() ? `# Project: ${project.name}\n\n${project.instructions.trim()}` : undefined;
    const projectTokens = projectUsable && conv.messageCount === 0 ? knowledgeTokens(allKnowledge) : 0;
    const userText = text || (newFiles.length === 1 ? "Please review the attached document." : "Please review the attached documents.");

    // One turn at a time per conversation: in a shared project two people may write at once, and the
    // messages of a turn are numbered from the history read below.
    if (!(await deps.repos.conversations.lock(key, id, new Date(now().getTime() + LOCK_MS).toISOString(), now().toISOString()))) {
      return apiError(reply, 409, "conversation_busy", "Someone else is sending a message in this conversation. Wait for the answer, then try again.");
    }
    const renew = setInterval(() => {
      void deps.repos.conversations.renew(key, id, new Date(now().getTime() + LOCK_MS).toISOString()).catch(() => undefined);
    }, LOCK_RENEW_MS);
    let unregister = () => {};
    const release = () => {
      clearInterval(renew);
      unregister();
      return deps.repos.conversations.unlock(key, id).catch(() => undefined);
    };

    // A partir de aquí la respuesta es SSE: los errores de negocio viajan como evento `error`.
    reply.hijack();
    const sse = new SseWriter(reply.raw, 15_000, { "content-security-policy": CSP });
    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    unregister = registerTurn({
      restart: () => {
        sse.send("error", { code: "server_restart", message: "The server is restarting for an update. The message is sent again in a moment.", retryable: true, partial: false });
        ac.abort();
      },
    });
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
    // A new conversation gets a topic title from its first message, made alongside the answer by the
    // cheapest model and saved when the turn ends; the person can still rename it.
    let titleReady: string | null = null;
    const titleWork: Promise<string> = deps.config.AUTO_TITLE === "true" && seq === 0 && DEFAULT_TITLE.test(conv.title) && text
      ? topicTitle(deps, text, ac.signal, (model, u) => void deps.repos.usage.add(userId, day, model, u).catch(() => undefined)).then((t) => { titleReady = t || null; return t; })
      : Promise.resolve("");
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
      // What was done with the new spreadsheets and ZIPs before the stream opened, as activity lines.
      const prepared = newFiles.filter((f) => f.sheet || f.zip);
      if (prepared.length > 0) {
        sse.send("step", {
          steps: prepared.map((f) => {
            if (f.zip) {
              const z = f.zip;
              const other = z.files - z.readable;
              return { id: `zip-${f.id}`, text: `Opened ${f.name}: ${z.files.toLocaleString("en-US")} ${z.files === 1 ? "file" : "files"}${other > 0 ? ` (${z.readable.toLocaleString("en-US")} readable, ${other.toLocaleString("en-US")} of other types)` : ""}. The model reads the ones it needs`, state: "done" as const };
            }
            const s = f.sheet!;
            const shape = `${s.rows.toLocaleString("en-US")} rows × ${s.columns} columns`;
            const partial = s.shown < s.rows ? `. The model sees the first ${s.shown.toLocaleString("en-US")} rows plus a summary of every column; the tabs it asks for are computed from all ${s.rows.toLocaleString("en-US")} rows` : "";
            return { id: `sheet-${f.id}`, text: `Read ${f.name}: ${shape}${partial}`, state: "done" as const };
          }),
        });
      }
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
      // Project files come first and are always planned the same way, so every conversation shares them;
      // one that does not fit whole is read page by page once and its transcription kept under the project.
      const plan = planDelivery([...knowledge, ...historyFiles, ...newFiles]);
      const toRead = [...knowledge, ...historyFiles, ...newFiles].filter((f) => plan.get(f.id) === "read");

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
            blocks.push(await contentBlock(store!, meta, cache, sheetChars));
          } catch {
            blocks.push({ type: "text", text: `[Attachment "${meta.name}" is no longer available]` });
          }
        }
        return blocks;
      };
      // The most recent set of earlier files gets the cache breakpoint unless the new turn brings its own
      // (at most 4 breakpoints per request).
      const latest = [...rawHistory].reverse().find((m) => m.role === "user" && (m.attachments?.length ?? 0) > 0);
      // The last few turns that used tools are replayed round by round; older ones keep their answer only.
      const toolTurns = rawHistory.filter((m) => m.role === "assistant" && m.tools?.key).map((m) => m.id);
      const replayed = new Set(toolTurns.slice(-TOOL_TURNS_REPLAYED));
      const history: StoredMessage[] = [];
      for (const m of rawHistory) {
        if (m.role === "assistant" && m.tools?.key) {
          if (!store || !replayed.has(m.id)) {
            history.push(withoutRounds(m));
            continue;
          }
          try {
            const rounds = (JSON.parse((await store.get(m.tools.key)).toString("utf8")) as { rounds: ToolRound[] }).rounds;
            history.push({ ...m, rounds });
          } catch {
            history.push(withoutRounds(m)); // the rounds are gone (expired): the answer stays
          }
          continue;
        }
        if (!store || m.role !== "user" || !m.attachments?.length) {
          history.push(m);
          continue;
        }
        const blocks = await blocksFor(m.attachments, newFiles.length === 0 && m === latest);
        history.push({ ...m, content: [...blocks, ...(m.content as BetaContentBlockParam[])] });
      }
      const userContent: BetaContentBlockParam[] = [...(store ? await blocksFor(newFiles, true) : []), { type: "text", text: userText }];
      if ((knowledge.length > 0 || libraryFiles.length > 0) && store) {
        const docs = await blocksFor(knowledge, knowledge.length > 0 && libraryFiles.length === 0);
        if (libraryFiles.length > 0 && deps.library && project) {
          docs.push({
            type: "document",
            title: "Project library",
            context: "The project's files that are not in this conversation. Read them on request with the tools: search_project_files to find which file and page mention something, list_project_files for the list, read_project_file for a file or a range of its pages. Cite the file and page of what you use; never describe a file you have not read.",
            source: { type: "text", media_type: "text/plain", data: await deps.library.manifest(project, libraryFiles) },
            cache_control: { type: "ephemeral", ttl: "1h" },
          } as BetaContentBlockParam);
        }
        const first = history[0];
        if (first && first.role === "user") history[0] = { ...first, content: [...docs, ...(first.content as BetaContentBlockParam[])] };
        else userContent.unshift(...docs);
      }
      const newTokens = newFileTokens(() => 0);
      if (contextBefore + newTokens > deps.config.CONTEXT_LIMIT_TOKENS) {
        return fail("context_limit", newFiles.length > 0 ? "The attached documents are too large for this conversation. Split them or start a new conversation." : "This conversation is too long; please start a new one");
      }

      // ZIPs in the conversation: the model reads inside them with tools, run here between rounds.
      const zips = [...historyFiles, ...newFiles].filter((f) => isZipType(f.contentType));
      const toolSets = [
        ...(zips.length > 0 && store ? [new ZipTools({ store, log: deps.log, zips, sheetChars })] : []),
        ...(libraryFiles.length > 0 && deps.library && project ? [deps.library.tools(project)] : []),
      ];
      const zipTools = toolSets.length > 0 ? new CombinedTools(toolSets) : null;

      // ---- The answer ----
      phase = "model";
      const emit = (ev: TurnEvent) => {
        switch (ev.type) {
          case "message_start": return sse.send("message_start", { userMessageId, assistantMessageId, model: ev.model });
          case "done": return sse.send("done", { assistantMessageId, model: ev.model, stopReason: ev.stopReason, usage: ev.usage, fallbackReason: ev.fallbackReason, ...(titleReady ? { title: titleReady } : {}) });
          default: { const { type, ...data } = ev; return sse.send(type, data); }
        }
      };
      const result = await deps.router.runTurn({
        conversation: conv,
        history,
        userText,
        userContent,
        systemPrompt: deps.systemPrompt.text,
        systemExtra,
        signal: ac.signal,
        emit,
        estimatedInputTokens: contextBefore + newTokens,
        ...(zipTools ? { tools: { definitions: zipTools.definitions, execute: (c, s, ctx) => zipTools.execute(c, s, ctx), describe: (c) => zipTools.describe(c) } } : {}),
      });
      if (result.ok) {
        const t = await titleWork;
        if (t) await deps.repos.conversations.update(key, id, { title: t }).catch(() => undefined);
      }
      const latencyMs = now().getTime() - started.getTime();
      if (result.ok && result.servedModel) {
        const createdAt = now().toISOString();
        const userMsg = storedUserMessage(createdAt);
        const assistantMsg: StoredMessage = { id: assistantMessageId, conversationId: id, seq: seq + 2, role: "assistant", content: result.content, model: result.servedModel, fallbackReason: result.fallbackReason, stopReason: result.stopReason, usage: result.usage, createdAt: now().toISOString() };
        if (result.rounds.length > 0 && store) {
          // What the tools returned can be large (files): it lives in storage, the message keeps a pointer and the activity list.
          const roundsKey = toolsKey(id, assistantMessageId);
          await store.put(roundsKey, Buffer.from(JSON.stringify({ rounds: result.rounds }), "utf8"), "application/json");
          assistantMsg.tools = { key: roundsKey, steps: result.steps };
        }
        await deps.repos.messages.append(userMsg, ttl);
        await deps.repos.messages.append(assistantMsg, ttl);
        await deps.repos.conversations.update(key, id, {
          messageCount: seq + 2,
          lastInputTokens: result.contextTokens,
          // No pin means the conversation's own model answered: clear any earlier pin (expired or stale).
          pinnedModel: result.pin?.model ?? null,
          pinReason: result.pin?.reason ?? null,
          pinnedUntil: result.pin?.until ?? null,
        });
        await deps.repos.usage.add(userId, day, result.servedModel, result.usage);
        await audit(deps, req, { action: "turn", conversationId: id, model: result.requestedModel, servedBy: result.servedModel, fallbackReason: result.fallbackReason ?? undefined, stopReason: result.stopReason ?? undefined, usage: result.usage, latencyMs, ...(result.rounds.length > 0 ? { meta: { toolRounds: result.rounds.length, toolCalls: result.rounds.reduce((n, r) => n + r.results.length, 0) } } : {}) });
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
        await audit(deps, req, { action: "turn_error", conversationId: id, model: result.requestedModel, latencyMs, meta: { errorClass: result.error?.errorClass ?? "unknown", kind: result.error?.kind ?? "unknown", partial: result.partial, ...(result.error?.status != null ? { status: result.error.status } : {}), ...(result.error?.detail ? { detail: result.error.detail } : {}) } });
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
