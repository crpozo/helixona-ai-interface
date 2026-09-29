import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { estimateTokens, modelByAlias, modelsForRole, ulid, type AttachmentMeta, type BetaContentBlockParam, type Conversation, type Project, type StoredMessage } from "@helixona/core";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth } from "../app.js";
import { canReadProject, projectPartition } from "./projects.js";
import { requireTraining } from "./training.js";
import { projectKnowledgeKey, safeName } from "../attachments/policy.js";

/**
 * Import from Claude: the browser reads the person's Claude.ai data export (conversations.json,
 * projects.json, memory) and sends it here in batches. Chats become conversations with their
 * messages and dates; Claude projects become projects (instructions plus their documents as
 * knowledge files); the memory becomes the instructions of the project the chats land in. Text
 * only: the export holds the text Claude extracted from attached files, never the files.
 */

const MAX_CONVERSATIONS_PER_REQUEST = 200;
const MAX_MESSAGES_PER_CONVERSATION = 2_000;
const MAX_MESSAGE_CHARS = 400_000;
const MAX_DOC_CHARS = 2_000_000;
const MAX_PROJECT_DOCS = 20;
/** One request may carry a few megabytes of chat text. */
export const IMPORT_BODY_LIMIT = 32 * 1024 * 1024;

const Attachment = z.object({ name: z.string().trim().min(1).max(200), text: z.string().max(MAX_DOC_CHARS).optional() });
const Message = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(MAX_MESSAGE_CHARS),
  createdAt: z.string().datetime({ offset: true }).optional(),
  attachments: z.array(Attachment).max(50).default([]),
});
const ImportedConversation = z.object({
  sourceId: z.string().min(1).max(100),
  name: z.string().max(200).default(""),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  /** The id of the project it belongs to here (a project created by the projects import, or the destination project). */
  projectId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).nullable().optional(),
  messages: z.array(Message).max(MAX_MESSAGES_PER_CONVERSATION),
});
const ImportedProject = z.object({
  sourceId: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).default(""),
  instructions: z.string().max(20_000).default(""),
  docs: z.array(z.object({ name: z.string().trim().min(1).max(200), text: z.string().max(MAX_DOC_CHARS) })).max(MAX_PROJECT_DOCS).default([]),
});

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function titleFor(name: string, createdAt: string): string {
  const t = name.trim();
  if (t) return t.slice(0, 120);
  const d = new Date(createdAt);
  return `Imported chat ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

export function registerImportRoutes(app: FastifyInstance, deps: Deps): void {
  const now = deps.now ?? (() => new Date());
  const ttl = deps.config.RETENTION_DAYS * 86400;

  /** Creates a project per Claude project; documents become knowledge files (Markdown text). */
  app.post("/api/import/claude/projects", { preHandler: requireAuth(), bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    if (!(await requireTraining(deps, req, reply))) return;
    const body = z.object({ projects: z.array(ImportedProject).max(100) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "The projects could not be read from the export");
    const s = req.session!;
    const existing = (await deps.repos.projects.list()).filter((p) => p.ownerId === s.userId);
    const created: Array<{ sourceId: string; id: string; docs: number; skipped: boolean }> = [];
    for (const ip of body.data.projects) {
      const dup = existing.find((p) => p.name === ip.name && p.description.startsWith("Imported from Claude"));
      if (dup) {
        created.push({ sourceId: ip.sourceId, id: dup.id, docs: dup.knowledge.length, skipped: true });
        continue;
      }
      const t = now().toISOString();
      const knowledge: AttachmentMeta[] = [];
      const id = ulid();
      if (deps.attachments) {
        for (const doc of ip.docs) {
          const text = doc.text.trim();
          if (!text) continue;
          const attachmentId = ulid();
          const name = safeName(/\.(md|txt|csv)$/i.test(doc.name) ? doc.name : `${doc.name}.md`);
          const bytes = Buffer.from(text, "utf8");
          const contentType = name.toLowerCase().endsWith(".csv") ? "text/csv" : name.toLowerCase().endsWith(".txt") ? "text/plain" : "text/markdown";
          const key = projectKnowledgeKey(id, attachmentId, name);
          await deps.attachments.put(key, bytes, contentType);
          knowledge.push({ id: attachmentId, name, contentType, size: bytes.length, pages: null, key });
        }
      }
      const description = `Imported from Claude${ip.description.trim() ? `: ${ip.description.trim()}` : ""}`.slice(0, 300);
      const p: Project = { id, ownerId: s.userId, ownerName: s.name, name: ip.name, description, instructions: ip.instructions, visibility: "private", members: [], knowledge, createdAt: t, updatedAt: t };
      await deps.repos.projects.create(p);
      existing.push(p);
      created.push({ sourceId: ip.sourceId, id, docs: knowledge.length, skipped: false });
    }
    await audit(deps, req, { action: "import_claude_projects", meta: { projects: created.filter((c) => !c.skipped).length, skipped: created.filter((c) => c.skipped).length, docs: created.reduce((n, c) => n + (c.skipped ? 0 : c.docs), 0) } });
    return { projects: created };
  });

  /** The project the chats land in when they belong to no Claude project; the memory becomes its instructions. */
  app.post("/api/import/claude/destination", { preHandler: requireAuth() }, async (req, reply) => {
    if (!(await requireTraining(deps, req, reply))) return;
    const body = z.object({ memory: z.string().max(20_000).default("") }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const s = req.session!;
    const t = now().toISOString();
    const memory = body.data.memory.trim();
    const instructions = memory ? `# Memory imported from Claude\n\nWhat Claude remembered about this person and their work. Use it as context; the person may update it here.\n\n${memory}` : "";
    const mine = (await deps.repos.projects.list()).filter((p) => p.ownerId === s.userId);
    let p = mine.find((x) => x.name === "Imported from Claude");
    if (p) {
      if (instructions && p.instructions !== instructions) p = (await deps.repos.projects.update(p.id, { instructions, updatedAt: t })) ?? p;
    } else {
      p = { id: ulid(), ownerId: s.userId, ownerName: s.name, name: "Imported from Claude", description: "Chats brought over from the Claude.ai account, with its memory as the instructions.", instructions, visibility: "private", members: [], knowledge: [], createdAt: t, updatedAt: t };
      await deps.repos.projects.create(p);
    }
    await audit(deps, req, { action: "import_claude_destination", meta: { projectId: p.id, memoryChars: memory.length } });
    return { projectId: p.id };
  });

  /** A batch of chats. A chat imported before (same source id) is skipped. */
  app.post("/api/import/claude/conversations", { preHandler: requireAuth(), bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    if (!(await requireTraining(deps, req, reply))) return;
    const body = z.object({ conversations: z.array(ImportedConversation).max(MAX_CONVERSATIONS_PER_REQUEST) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "The chats could not be read from the export");
    const s = req.session!;
    const entry = modelByAlias(deps.catalog, deps.catalog.defaultAlias) ?? deps.catalog.models[0]!;
    const model = modelsForRole(deps.catalog, s.roles).some((m) => m.alias === entry.alias) ? entry : modelsForRole(deps.catalog, s.roles)[0] ?? entry;
    const already = new Set((await deps.repos.conversations.list(s.userId)).map((c) => c.importedFrom).filter((x): x is string => !!x));
    const projects = new Map<string, Project | null>();
    const results: Array<{ sourceId: string; id: string | null; status: "imported" | "skipped" | "empty" }> = [];
    let messagesImported = 0;
    for (const ic of body.data.conversations) {
      if (already.has(ic.sourceId)) {
        results.push({ sourceId: ic.sourceId, id: null, status: "skipped" });
        continue;
      }
      let projectId: string | null = null;
      let key = s.userId;
      if (ic.projectId && ULID.test(ic.projectId)) {
        if (!projects.has(ic.projectId)) projects.set(ic.projectId, await deps.repos.projects.get(ic.projectId));
        const p = projects.get(ic.projectId);
        if (p && canReadProject(p, s.userId)) {
          projectId = p.id;
          if (p.visibility === "shared") key = projectPartition(p.id);
        }
      }
      const createdAt = ic.createdAt ?? now().toISOString();
      const updatedAt = ic.updatedAt ?? createdAt;
      const id = ulid();
      const stored: StoredMessage[] = [];
      let chars = 0;
      for (const m of ic.messages) {
        const text = m.text.trim();
        const docs: BetaContentBlockParam[] = [];
        for (const a of m.attachments) {
          const t = (a.text ?? "").trim();
          if (t) docs.push({ type: "document", title: safeName(a.name), source: { type: "text", media_type: "text/plain", data: t } } as BetaContentBlockParam);
          chars += t.length;
        }
        const note = m.attachments.length > 0 ? `[Attached in Claude: ${m.attachments.map((a) => safeName(a.name)).join(", ")}]` : "";
        const body = [text, note].filter(Boolean).join("\n\n");
        if (!body && docs.length === 0) continue;
        chars += body.length;
        stored.push({
          id: ulid(),
          conversationId: id,
          seq: stored.length + 1,
          role: m.role,
          content: [...docs, { type: "text", text: body || "(attachment)" }] as BetaContentBlockParam[],
          ...(m.role === "user" ? { authorId: s.userId, authorName: s.name } : {}),
          model: null,
          fallbackReason: null,
          stopReason: m.role === "assistant" ? "end_turn" : null,
          usage: null,
          createdAt: m.createdAt ?? createdAt,
        });
      }
      if (stored.length === 0) {
        results.push({ sourceId: ic.sourceId, id: null, status: "empty" });
        continue;
      }
      const c: Conversation = {
        id, userId: key, title: titleFor(ic.name, createdAt), modelAlias: model.alias, modelId: model.modelId,
        pinnedModel: null, pinReason: null, pinnedUntil: null, systemPromptVersion: deps.systemPrompt.version,
        createdAt, updatedAt, messageCount: stored.length, lastInputTokens: estimateTokens("x".repeat(chars)), projectId,
        createdBy: s.userId, createdByName: s.name, importedFrom: ic.sourceId,
      };
      await deps.repos.conversations.create(c, ttl);
      for (const m of stored) await deps.repos.messages.append(m, ttl);
      already.add(ic.sourceId);
      messagesImported += stored.length;
      results.push({ sourceId: ic.sourceId, id, status: "imported" });
    }
    await audit(deps, req, { action: "import_claude_conversations", meta: { imported: results.filter((r) => r.status === "imported").length, skipped: results.filter((r) => r.status === "skipped").length, empty: results.filter((r) => r.status === "empty").length, messages: messagesImported } });
    return { conversations: results };
  });
}
