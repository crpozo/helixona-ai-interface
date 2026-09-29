/**
 * Reads a Claude.ai data export (Settings → Privacy → Export data: a zip with conversations.json,
 * projects.json and users.json, sometimes a memory file) in the browser, into what the assistant
 * imports. Only the shapes we use are read; unknown fields are ignored, so a newer export still
 * loads. Nothing here leaves the browser until the person starts the import.
 */

export interface ExportMessage {
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  attachments: Array<{ name: string; text?: string }>;
}
export interface ExportConversation {
  sourceId: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  /** The Claude project it belonged to, when the export says. */
  projectSourceId: string | null;
  messages: ExportMessage[];
}
export interface ExportProject {
  sourceId: string;
  name: string;
  description: string;
  instructions: string;
  docs: Array<{ name: string; text: string }>;
}
export interface ClaudeExport {
  conversations: ExportConversation[];
  projects: ExportProject[];
  /** The memory text found in the export, or "" (it can be pasted instead). */
  memory: string;
  /** What was read, for the summary ("conversations.json, projects.json"). */
  files: string[];
  /** Files in the export that were not used (frames, metadata), so the person knows nothing was missed by accident. */
  ignored: string[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const iso = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

/** The text of a message: its `text`, or the text blocks of `content` (newer exports). */
function messageText(m: Json): string {
  const direct = str(m.text).trim();
  if (direct) return direct;
  return arr(m.content)
    .map((b) => {
      const block = obj(b);
      return block && (block.type === "text" || block.type === undefined) ? str(block.text) : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function parseConversations(json: unknown): ExportConversation[] {
  return arr(json).flatMap((raw) => {
    const c = obj(raw);
    if (!c) return [];
    const sourceId = str(c.uuid) || str(c.id);
    if (!sourceId) return [];
    const project = obj(c.project);
    const messages: ExportMessage[] = arr(c.chat_messages ?? c.messages).flatMap((rm) => {
      const m = obj(rm);
      if (!m) return [];
      const sender = str(m.sender) || str(m.role);
      const role = sender === "human" || sender === "user" ? "user" : sender === "assistant" ? "assistant" : null;
      if (!role) return [];
      const attachments = [...arr(m.attachments), ...arr(m.files)].flatMap((ra) => {
        const a = obj(ra);
        const name = a ? str(a.file_name) || str(a.name) : "";
        if (!name) return [];
        const text = a ? str(a.extracted_content) : "";
        return [text ? { name, text } : { name }];
      });
      const text = messageText(m);
      if (!text && attachments.length === 0) return [];
      return [{ role, text, createdAt: iso(m.created_at), attachments }];
    });
    return [{ sourceId, name: str(c.name).trim(), createdAt: iso(c.created_at), updatedAt: iso(c.updated_at), projectSourceId: str(c.project_uuid) || (project ? str(project.uuid) : "") || null, messages }];
  });
}

export function parseProjects(json: unknown): ExportProject[] {
  return arr(json).flatMap((raw) => {
    const p = obj(raw);
    if (!p) return [];
    const sourceId = str(p.uuid) || str(p.id);
    const name = str(p.name).trim();
    if (!sourceId || !name) return [];
    const docs = arr(p.docs).flatMap((rd) => {
      const d = obj(rd);
      const docName = d ? str(d.filename) || str(d.name) : "";
      const text = d ? str(d.content) : "";
      return docName && text.trim() ? [{ name: docName, text }] : [];
    });
    return [{ sourceId, name: name.slice(0, 80), description: str(p.description).trim().slice(0, 300), instructions: str(p.prompt_template).trim(), docs }];
  });
}

/** Memory can come as plain text or as JSON of strings; anything that is text is kept, in order. */
export function parseMemory(text: string): string {
  const t = text.trim();
  if (!t) return "";
  if (!/^[[{]/.test(t)) return t;
  try {
    const out: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") out.push(v.trim());
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, val] of Object.entries(v as Json)) if (!/^(uuid|id|created_at|updated_at|account)/.test(k)) walk(val);
    };
    walk(JSON.parse(t));
    return out.filter(Boolean).join("\n").trim();
  } catch {
    return t;
  }
}

/** Conversations from a JSON document: an array, an object holding one, or a single conversation. */
function conversationsIn(json: unknown): ExportConversation[] {
  if (Array.isArray(json)) return parseConversations(json);
  const o = obj(json);
  if (!o) return [];
  if (Array.isArray(o.conversations)) return parseConversations(o.conversations);
  if (Array.isArray(o.chat_messages) || Array.isArray(o.messages)) return parseConversations([o]);
  return [];
}

function projectsIn(json: unknown): ExportProject[] {
  if (Array.isArray(json)) return parseProjects(json);
  const o = obj(json);
  if (!o) return [];
  if (Array.isArray(o.projects)) return parseProjects(o.projects);
  if (o.name !== undefined && (o.docs !== undefined || o.prompt_template !== undefined)) return parseProjects([o]);
  return [];
}

type Category = "conversations" | "projects" | "memory" | "manifest" | "other";

/** What a file holds, from its name and the zip it came in (the newer export ships one zip per category). */
function categoryOf(name: string, zipName: string | null): Category {
  const n = name.toLowerCase();
  const z = (zipName ?? "").toLowerCase();
  if (/manifest/.test(n)) return "manifest";
  if (/conversation/.test(n) || /^conversations/.test(z)) return /\.json$/.test(n) ? "conversations" : "other";
  if (/project/.test(n) || /^projects/.test(z)) return /\.json$/.test(n) ? "projects" : "other";
  if (/memor/.test(n) || /^memor/.test(z)) return /\.(json|txt|md)$/.test(n) ? "memory" : "other";
  return "other";
}

export interface ReadOptions {
  /** An export read earlier in the same session, to add these files to. */
  previous?: ClaudeExport | null;
}

/**
 * Reads the export from the files the person picked: the zip Claude sends, or the several zips of
 * the newer export (conversations-000.zip, projects-000.zip, memories-000.zip…), or the files
 * inside them. Files can be added in several picks; chats and projects are not repeated.
 */
export async function readClaudeExport(files: File[], opts: ReadOptions = {}): Promise<ClaudeExport> {
  const prev = opts.previous ?? null;
  const result: ClaudeExport = { conversations: [...(prev?.conversations ?? [])], projects: [...(prev?.projects ?? [])], memory: prev?.memory ?? "", files: [...(prev?.files ?? [])], ignored: [...(prev?.ignored ?? [])] };
  const entries: Array<{ name: string; zip: string | null; text: () => Promise<string> }> = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name) || f.type === "application/zip" || f.type === "application/x-zip-compressed") {
      const { default: JSZip } = await import("jszip");
      const zip = await JSZip.loadAsync(await f.arrayBuffer());
      for (const [path, entry] of Object.entries(zip.files)) {
        if (!entry.dir) entries.push({ name: path.split("/").pop() ?? path, zip: f.name, text: () => entry.async("string") });
      }
    } else entries.push({ name: f.name, zip: null, text: () => f.text() });
  }
  let manifest = false;
  const seenChats = new Set(result.conversations.map((c) => c.sourceId));
  const seenProjects = new Set(result.projects.map((p) => p.sourceId));
  let added = 0;
  for (const e of entries) {
    const label = e.zip ? `${e.zip} › ${e.name}` : e.name;
    const category = categoryOf(e.name, e.zip);
    try {
      if (category === "conversations") {
        const found = conversationsIn(JSON.parse(await e.text())).filter((c) => !seenChats.has(c.sourceId));
        found.forEach((c) => seenChats.add(c.sourceId));
        result.conversations.push(...found);
        result.files.push(label);
        added++;
      } else if (category === "projects") {
        const found = projectsIn(JSON.parse(await e.text())).filter((p) => !seenProjects.has(p.sourceId));
        found.forEach((p) => seenProjects.add(p.sourceId));
        result.projects.push(...found);
        result.files.push(label);
        added++;
      } else if (category === "memory") {
        const m = parseMemory(await e.text());
        if (m && !result.memory.includes(m)) result.memory = result.memory ? `${result.memory}\n\n${m}` : m;
        result.files.push(label);
        added++;
      } else if (category === "manifest") {
        manifest = true;
      } else if (!result.ignored.includes(label)) result.ignored.push(label);
    } catch {
      if (!result.ignored.includes(label)) result.ignored.push(`${label} (could not be read)`);
    }
  }
  if (added === 0) {
    if (manifest) throw new Error("That is the manifest, the list of download links Claude gives you. Open each link (they work once), save the zips it downloads, and drop the conversations, projects and memories zips here.");
    throw new Error(`No conversations, projects or memory file was found. Pick the zip or zips you downloaded from Claude (conversations-000.zip, projects-000.zip, memories-000.zip) or the files inside them.${result.ignored.length > 0 ? ` Files seen: ${result.ignored.slice(0, 8).join(", ")}.` : ""}`);
  }
  return result;
}

/** Splits conversations into requests of at most `maxChars` of text each (and at most `maxCount` chats). */
export function batches<T extends { messages: Array<{ text: string; attachments: Array<{ text?: string }> }> }>(items: T[], maxChars = 3_000_000, maxCount = 100): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const it of items) {
    const chars = it.messages.reduce((n, m) => n + m.text.length + m.attachments.reduce((k, a) => k + (a.text?.length ?? 0), 0), 0);
    if (current.length > 0 && (size + chars > maxChars || current.length >= maxCount)) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(it);
    size += chars;
  }
  if (current.length > 0) out.push(current);
  return out;
}
