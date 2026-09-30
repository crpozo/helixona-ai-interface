import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { estimateTokens, modelByAlias, modelsForRole, ulid, type AttachmentMeta, type BetaContentBlockParam, type Conversation, type Project, type ProjectMember, type StoredMessage } from "@helixona/core";
import type { Deps } from "../deps.js";
import { apiError, audit, requireAuth } from "../app.js";
import { canReadProject, MAX_MEMBERS, projectPartition } from "./projects.js";
import { requireTraining } from "./training.js";
import { attachmentKey, projectKnowledgeKey, safeName } from "../attachments/policy.js";

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
/**
 * A stored message must stay well under DynamoDB's 400 KB item limit, so the text Claude extracted
 * from an attachment becomes a text file in the attachments store (read back like an uploaded file)
 * and a very long message keeps its full text in a file too, with the start inline.
 */
const INLINE_TEXT_BYTES = 120_000;
const INLINE_FALLBACK_CHARS = 60_000;
/** Text files may be 5 MB (attachments/policy.ts); stay under it. */
const MAX_TEXT_FILE_BYTES = 4_500_000;
const MESSAGE_TEXT_FILE = "Message text.txt";

/** A failure of one step of the import, reported with the step's name and the error's class, never its content. */
class ImportStepError extends Error {
  constructor(readonly step: string, readonly errorClass: string) {
    super(`The import failed while ${step} (${errorClass})`);
  }
}
const errorClass = (e: unknown) => (e instanceof Error && e.name ? e.name : "Error");
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw new ImportStepError(name, errorClass(e));
  }
}
/** Cuts a text so it fits in `maxBytes` of UTF-8. */
function cutBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) end = Math.floor(end * 0.9);
  return text.slice(0, end);
}
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
  /** Kept beyond the retention period (a backup); deleted only by hand. */
  archive: z.boolean().default(false),
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

  /** A Markdown knowledge file in a project, replacing one with the same name (a re-run of the import). */
  async function putKnowledgeFile(p: Project, name: string, text: string): Promise<Project> {
    if (!deps.attachments) return p;
    const attachmentId = ulid();
    const bytes = Buffer.from(text, "utf8");
    const key = projectKnowledgeKey(p.id, attachmentId, name);
    await deps.attachments.put(key, bytes, "text/markdown");
    const stale = p.knowledge.filter((k) => k.name === name);
    for (const k of stale) await deps.attachments.deletePrefix(`projects/${p.id}/${k.id}/`).catch(() => undefined);
    const knowledge = [...p.knowledge.filter((k) => k.name !== name), { id: attachmentId, name, contentType: "text/markdown", size: bytes.length, pages: null, key }];
    return (await deps.repos.projects.update(p.id, { knowledge, updatedAt: now().toISOString() })) ?? p;
  }

  /**
   * The project the chats land in: the memory becomes its instructions, the files of Claude's
   * memory directory one knowledge file, and (when the Claude projects are folded in) their
   * instructions, memory and documents another. Private ("Imported from Claude"), or shared with the
   * whole team ("Backup Claude": every enabled account is a member, so everyone sees the chats and
   * can ask about them).
   */
  app.post("/api/import/claude/destination", { preHandler: requireAuth(), bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    if (!(await requireTraining(deps, req, reply))) return;
    const body = z
      .object({ memory: z.string().max(20_000).default(""), memoryFiles: z.string().max(MAX_DOC_CHARS).default(""), projectFiles: z.string().max(MAX_DOC_CHARS).default(""), team: z.boolean().default(false) })
      .safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "Invalid request");
    const s = req.session!;
    const started = Date.now();
    const t = now().toISOString();
    const memory = body.data.memory.trim();
    const team = body.data.team;
    const name = team ? "Backup Claude" : "Imported from Claude";
    const who = team ? "the team" : "this person";
    const instructions = memory ? `# Memory imported from Claude\n\nWhat Claude remembered about ${who} and their work. Use it as context; it can be updated here.\n\n${memory}` : "";
    const files = body.data.memoryFiles.trim();
    const projectFiles = body.data.projectFiles.trim();
    try {
      const all = await step("listing the projects", () => deps.repos.projects.list());
      let p = all.find((x) => x.name === name && (team ? x.visibility === "shared" : x.ownerId === s.userId));
      if (p && team && p.ownerId !== s.userId && !s.roles.includes("admin")) return apiError(reply, 403, "forbidden", `"${name}" belongs to someone else. Ask its owner or an administrator to run the import.`);
      const accounts = team ? await step("reading the list of accounts", () => deps.directory.list()) : [];
      const members: ProjectMember[] = accounts.filter((u) => u.enabled && u.id !== s.userId).slice(0, MAX_MEMBERS).map((u) => ({ id: u.id, name: u.name, email: u.email, addedAt: t }));
      if (p) {
        const patch: { instructions?: string; members?: ProjectMember[] } = {};
        if (instructions && p.instructions !== instructions) patch.instructions = instructions;
        if (team) {
          const missing = members.filter((m) => !p!.members.some((x) => x.id === m.id));
          if (missing.length > 0) patch.members = [...p.members, ...missing].slice(0, MAX_MEMBERS);
        }
        if (Object.keys(patch).length > 0) p = (await step("updating the project", () => deps.repos.projects.update(p!.id, { ...patch, updatedAt: t }))) ?? p;
      } else {
        const created: Project = {
          id: ulid(), ownerId: s.userId, ownerName: s.name, name,
          description: team ? "Everything brought over from the Claude.ai account, shared with the whole team: chats, memory and projects. Ask it anything." : "Chats brought over from the Claude.ai account, with its memory as the instructions.",
          instructions, visibility: team ? "shared" : "private", members, knowledge: [], createdAt: t, updatedAt: t,
        };
        await step("creating the project", () => deps.repos.projects.create(created));
        p = created;
      }
      if (files) p = await step("saving the memory files", () => putKnowledgeFile(p!, "Claude memory files.md", `# Claude memory files\n\nThe files of Claude's memory directory, brought over from the Claude.ai account.\n\n${files}`));
      if (projectFiles) p = await step("saving the Claude projects file", () => putKnowledgeFile(p!, "Claude projects.md", `# Claude projects\n\nThe projects of the Claude.ai account: their instructions, memory and documents.\n\n${projectFiles}`));
      await audit(deps, req, { action: "import_claude_destination", meta: { projectId: p.id, team, members: p.members.length, memoryChars: memory.length, memoryFilesChars: files.length, projectFilesChars: projectFiles.length } });
      // Sizes and timing only, so a slow or failed import can be traced in the logs without content.
      deps.log.info("import_claude_destination", { ms: Date.now() - started, team, members: p.members.length, memoryFilesChars: files.length, projectFilesChars: projectFiles.length });
      return { projectId: p.id, name: p.name, members: p.members.length };
    } catch (e) {
      if (!(e instanceof ImportStepError)) throw e;
      deps.log.error("import_claude_destination_failed", { step: e.step, errorClass: e.errorClass, team, memoryFilesChars: files.length, projectFilesChars: projectFiles.length });
      return apiError(reply, 500, "import_failed", `${e.message}. Tell the administrator; nothing else was changed.`);
    }
  });

  /** A batch of chats. A chat imported before (same source id) is skipped. */
  app.post("/api/import/claude/conversations", { preHandler: requireAuth(), bodyLimit: IMPORT_BODY_LIMIT }, async (req, reply) => {
    if (!(await requireTraining(deps, req, reply))) return;
    const body = z.object({ conversations: z.array(ImportedConversation).max(MAX_CONVERSATIONS_PER_REQUEST) }).safeParse(req.body);
    if (!body.success) return apiError(reply, 400, "bad_request", "The chats could not be read from the export");
    const s = req.session!;
    const entry = modelByAlias(deps.catalog, deps.catalog.defaultAlias) ?? deps.catalog.models[0]!;
    const model = modelsForRole(deps.catalog, s.roles).some((m) => m.alias === entry.alias) ? entry : modelsForRole(deps.catalog, s.roles)[0] ?? entry;
    const projects = new Map<string, Project | null>();
    // What was imported before, per place the chats are stored: the person's own conversations, or a
    // shared project's (its chats belong to the team). The same chat may exist in both.
    const already = new Map<string, Set<string>>();
    const importedInto = async (key: string): Promise<Set<string>> => {
      let set = already.get(key);
      if (!set) {
        set = new Set((await deps.repos.conversations.list(key)).map((c) => c.importedFrom).filter((x): x is string => !!x));
        already.set(key, set);
      }
      return set;
    };
    const results: Array<{ sourceId: string; id: string | null; status: "imported" | "skipped" | "empty" | "failed"; reason?: string }> = [];
    let messagesImported = 0;
    const store = deps.attachments;
    for (const ic of body.data.conversations) {
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
      const done = await importedInto(key);
      if (done.has(ic.sourceId)) {
        results.push({ sourceId: ic.sourceId, id: null, status: "skipped" });
        continue;
      }
      const createdAt = ic.createdAt ?? now().toISOString();
      const updatedAt = ic.updatedAt ?? createdAt;
      const id = ulid();
      const stored: StoredMessage[] = [];
      const files: Array<{ key: string; bytes: Buffer }> = [];
      let chars = 0;
      /** A text as a file of this conversation (read back like an uploaded file), or null when there is no store. */
      const textFile = (name: string, text: string): AttachmentMeta | null => {
        if (!store) return null;
        const attachmentId = ulid();
        const bytes = Buffer.from(cutBytes(text, MAX_TEXT_FILE_BYTES), "utf8");
        const k = attachmentKey(id, attachmentId, name);
        files.push({ key: k, bytes });
        return { id: attachmentId, name: safeName(name), contentType: "text/plain", size: bytes.length, pages: null, key: k };
      };
      for (const m of ic.messages) {
        let text = m.text.trim();
        const docs: BetaContentBlockParam[] = [];
        const attached: AttachmentMeta[] = [];
        for (const a of m.attachments) {
          const t = (a.text ?? "").trim();
          if (!t) continue;
          chars += t.length;
          // The text Claude extracted from the file, as a text file next to the message.
          const meta = m.role === "user" ? textFile(`${safeName(a.name)}.txt`, t) : null;
          if (meta) attached.push(meta);
          else docs.push({ type: "document", title: safeName(a.name), source: { type: "text", media_type: "text/plain", data: t.slice(0, INLINE_FALLBACK_CHARS) } } as BetaContentBlockParam);
        }
        const note = m.attachments.length > 0 ? `[Attached in Claude: ${m.attachments.map((a) => safeName(a.name)).join(", ")}]` : "";
        if (Buffer.byteLength(text, "utf8") > INLINE_TEXT_BYTES) {
          const meta = m.role === "user" ? textFile(MESSAGE_TEXT_FILE, text) : null;
          if (meta) attached.push(meta);
          text = `${cutBytes(text, meta ? INLINE_TEXT_BYTES : INLINE_TEXT_BYTES / 2)}\n\n[${meta ? `Long message: the full text is in the attached file "${MESSAGE_TEXT_FILE}"` : "Long message shortened at import"}]`;
        }
        const body = [text, note].filter(Boolean).join("\n\n");
        if (!body && docs.length === 0 && attached.length === 0) continue;
        chars += body.length;
        stored.push({
          id: ulid(),
          conversationId: id,
          seq: stored.length + 1,
          role: m.role,
          content: [...docs, { type: "text", text: body || "(attachment)" }] as BetaContentBlockParam[],
          ...(attached.length > 0 ? { attachments: attached } : {}),
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
        createdBy: s.userId, createdByName: s.name, importedFrom: ic.sourceId, ...(ic.archive ? { archived: true } : {}),
      };
      const life = ic.archive ? null : ttl;
      try {
        // Files and messages first, the conversation last: a failure leaves no half-imported chat behind.
        for (const f of files) await step("saving an attachment's text", () => store!.put(f.key, f.bytes, "text/plain"));
        for (const m of stored) await step("saving a message", () => deps.repos.messages.append(m, life));
        await step("saving the conversation", () => deps.repos.conversations.create(c, life));
      } catch (e) {
        const err = e instanceof ImportStepError ? e : new ImportStepError("saving the chat", errorClass(e));
        deps.log.warn("import_claude_conversation_failed", { step: err.step, errorClass: err.errorClass, messages: stored.length, files: files.length, chars });
        await deps.repos.messages.deleteAll(id).catch(() => undefined);
        if (store && files.length > 0) await store.deletePrefix(`conversations/${id}/`).catch(() => undefined);
        results.push({ sourceId: ic.sourceId, id: null, status: "failed", reason: `${err.step}: ${err.errorClass}` });
        continue;
      }
      done.add(ic.sourceId);
      messagesImported += stored.length;
      results.push({ sourceId: ic.sourceId, id, status: "imported" });
    }
    await audit(deps, req, { action: "import_claude_conversations", meta: { imported: results.filter((r) => r.status === "imported").length, skipped: results.filter((r) => r.status === "skipped").length, empty: results.filter((r) => r.status === "empty").length, failed: results.filter((r) => r.status === "failed").length, messages: messagesImported, archived: body.data.conversations.filter((c) => c.archive).length } });
    return { conversations: results };
  });
}
