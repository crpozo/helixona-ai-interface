import type { BetaTool, BetaToolResultBlockParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { AttachmentMeta, Project, SafeLogger, ToolCall, ToolOutput, UsageSummary } from "@helixona/core";
import type { Repos } from "../repos/types.js";
import type { AttachmentStore } from "./store.js";
import type { DocumentReader } from "./reader.js";
import { planKnowledge, type KnowledgeMode } from "./planner.js";
import { isSpreadsheet, readTables, SpreadsheetError, tablesForModel } from "./sheets.js";

/**
 * A project's library: the files that do not travel with every message (too large for a request, or
 * beyond the budget of files that do). A PDF in the library is read page by page in the background,
 * right after it is added, and the transcription is kept under the project. The model gets the list
 * of library files with every message and three tools to list, search and read them on request, so a
 * project can hold a whole record request without a size wall and without filling the conversation.
 */
const EMPTY_USAGE: UsageSummary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0 };

export const LIBRARY = {
  /** Characters of a file one read returns by default; the note at the cut says how to continue. */
  charsPerRead: 200_000,
  maxCharsPerRead: 400_000,
  searchDefaultResults: 40,
  searchMaxResults: 100,
} as const;

interface Job {
  pagesDone: number;
  pages: number | null;
  promise: Promise<void>;
}

export interface LibraryOptions {
  store: AttachmentStore;
  reader: DocumentReader;
  repos: Repos;
  log: SafeLogger;
  sheetChars: number;
  now?: () => Date;
}

export class ProjectLibrary {
  private readonly jobs = new Map<string, Job>();
  private readonly now: () => Date;

  constructor(private readonly opts: LibraryOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /** The split of a project's files: whole (with every message) or library (on request). */
  modes(p: Project): Map<string, KnowledgeMode> {
    return planKnowledge(p.knowledge);
  }

  /** The reading status of a file as the project page shows it: live progress while a job runs. */
  status(meta: AttachmentMeta): AttachmentMeta["reading"] {
    const job = this.jobs.get(meta.id);
    if (job) return { state: "pending", pages: job.pages ?? meta.pages, pagesDone: job.pagesDone };
    return meta.reading;
  }

  /** Starts reading every library PDF that is not read yet (after a restart, or when added). Does not wait. */
  ensureAll(p: Project): void {
    const modes = this.modes(p);
    for (const k of p.knowledge) {
      if (modes.get(k.id) === "library" && k.contentType === "application/pdf" && k.reading?.state !== "done" && !this.jobs.has(k.id)) this.start(p, k);
    }
  }

  /** Resolves when no reading is running (tests). */
  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs.values()].map((j) => j.promise.catch(() => undefined)));
  }

  private start(p: Project, meta: AttachmentMeta): void {
    const job: Job = { pagesDone: 0, pages: meta.pages, promise: Promise.resolve() };
    const userId = meta.uploadedBy ?? p.ownerId;
    const spent: UsageSummary = { ...EMPTY_USAGE };
    const started = this.now().getTime();
    job.promise = (async () => {
      let reading: AttachmentMeta["reading"];
      try {
        const r = await this.opts.reader.read(meta, {
          signal: new AbortController().signal,
          conversationId: `project:${p.id}`,
          onProgress: (done, total) => { job.pagesDone = done; if (total !== null) job.pages = total; },
          onUsage: (u) => { spent.inputTokens += u.inputTokens; spent.outputTokens += u.outputTokens; spent.cacheReadTokens += u.cacheReadTokens; spent.cacheWriteTokens += u.cacheWriteTokens; spent.estimatedUsd += u.estimatedUsd; },
        });
        reading = { state: "done", pages: r.pages ?? meta.pages, pagesDone: r.pages ?? meta.pages ?? 0, ...(r.failedPages.length > 0 ? { failedPages: r.failedPages } : {}) };
      } catch (e) {
        this.opts.log.warn("project_file_read_failed", { errorClass: e instanceof Error ? e.name : "unknown" });
        reading = { state: "failed", pages: job.pages, pagesDone: job.pagesDone };
      }
      // Persist on the project as it is now (a colleague may have added files meanwhile).
      try {
        const fresh = await this.opts.repos.projects.get(p.id);
        if (fresh && fresh.knowledge.some((k) => k.id === meta.id)) {
          await this.opts.repos.projects.update(p.id, { knowledge: fresh.knowledge.map((k) => (k.id === meta.id ? { ...k, reading } : k)) });
        }
        const day = this.now().toISOString().slice(0, 10);
        if (spent.inputTokens + spent.outputTokens > 0) await this.opts.repos.usage.add(userId, day, this.opts.reader.modelId, spent);
        await this.opts.repos.audit.put({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, ts: this.now().toISOString(), day, userId, action: "project_file_read", model: this.opts.reader.modelId, usage: spent, latencyMs: this.now().getTime() - started, meta: { projectId: p.id, attachmentId: meta.id, pages: reading?.pages ?? 0, failed: reading?.state === "failed" } });
      } catch (e) {
        this.opts.log.warn("project_file_read_record_failed", { errorClass: e instanceof Error ? e.name : "unknown" });
      } finally {
        this.jobs.delete(meta.id);
      }
    })();
    this.jobs.set(meta.id, job);
  }

  /** The text of a library file: a PDF's transcription, a spreadsheet's rows, a text file as it is. Null while a PDF is still being read. */
  async text(meta: AttachmentMeta): Promise<string | null> {
    if (meta.contentType === "application/pdf") return this.opts.reader.cached(meta);
    const bytes = await this.opts.store.get(meta.key);
    if (isSpreadsheet(meta.contentType)) {
      try {
        return tablesForModel(meta.name, await readTables(meta.contentType, bytes), this.opts.sheetChars);
      } catch (e) {
        return e instanceof SpreadsheetError ? `[Could not be read as a spreadsheet: ${e.message}]` : "[Could not be read as a spreadsheet]";
      }
    }
    return bytes.toString("utf8").replace(/^\uFEFF/, "");
  }

  /** The list the model receives with every message of a project that has library files. */
  manifest(p: Project, library: AttachmentMeta[]): string {
    const lines = library.map((k) => {
      const st = this.status(k);
      const pages = st?.pages ?? k.pages;
      const size = pages ? `${pages.toLocaleString("en-US")} pages` : `${Math.max(1, Math.round(k.size / 1024)).toLocaleString("en-US")} KB`;
      const state = k.contentType !== "application/pdf" ? "ready" : st?.state === "done" ? (st.failedPages?.length ? `ready (pages ${st.failedPages.join(", ")} could not be read)` : "ready") : st?.state === "failed" ? "could not be read" : `being read (${(st?.pagesDone ?? 0).toLocaleString("en-US")} of ${pages?.toLocaleString("en-US") ?? "?"} pages so far)`;
      return `${k.name} · ${size} · ${state}`;
    });
    return `Project "${p.name}" library: ${library.length === 1 ? "1 file" : `${library.length} files`} available on request, not in this conversation until you read them.\nFiles (name · size · status):\n${lines.join("\n")}`;
  }

  tools(p: Project): LibraryTools {
    return new LibraryTools(this, p);
  }
}

const NameField = z.string().min(1).max(200);
const ListInput = z.object({ pattern: z.string().max(200).optional() }).strict();
const ReadInput = z.object({ name: NameField, from_page: z.number().int().min(1).optional(), to_page: z.number().int().min(1).optional(), offset: z.number().int().min(0).optional(), max_chars: z.number().int().min(1000).max(LIBRARY.maxCharsPerRead).optional() }).strict();
const SearchInput = z.object({ query: z.string().min(1).max(200), regex: z.boolean().optional(), max_results: z.number().int().min(1).max(LIBRARY.searchMaxResults).optional() }).strict();

export const LIBRARY_TOOLS: BetaTool[] = [
  {
    name: "list_project_files",
    description: "Lists the project's library files (the ones available on request, with their size and whether they are ready), optionally those whose name contains `pattern`. The files that already travel with the conversation are not listed: you have them.",
    input_schema: { type: "object", properties: { pattern: { type: "string", description: "Keep names that contain this text (case-insensitive)" } }, required: [], additionalProperties: false },
  },
  {
    name: "search_project_files",
    description: "Finds which library files of the project mention something, with the matching lines and their page: a case-insensitive search for `query` (plain text, or a regular expression when `regex` is true) over the transcriptions of the library's PDFs and the text of its other files. Use it to find the right file and page before reading.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 200, description: "Text to find, or a regular expression when regex is true" },
        regex: { type: "boolean", description: "Treat query as a regular expression" },
        max_results: { type: "integer", minimum: 1, maximum: LIBRARY.searchMaxResults, description: `Matching lines to return (default ${LIBRARY.searchDefaultResults})` },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_project_file",
    description: `Returns the contents of one library file of the project: a PDF as its page-by-page transcription (every page starts with "(p. N)"; use from_page and to_page to read a range), a spreadsheet as rows with their row numbers, a text file as it is. Long text is cut at max_chars (${LIBRARY.charsPerRead.toLocaleString("en-US")} by default) with the offset to continue. Read the pages the question needs, a range at a time; cite the file and page of what you use.`,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The file name, exactly as listed" },
        from_page: { type: "integer", minimum: 1, description: "First page to return (PDFs)" },
        to_page: { type: "integer", minimum: 1, description: "Last page to return (PDFs)" },
        offset: { type: "integer", minimum: 0, description: "Characters to skip (to continue a long text)" },
        max_chars: { type: "integer", minimum: 1000, maximum: LIBRARY.maxCharsPerRead, description: "Characters to return" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
];

type ResultBlocks = Exclude<BetaToolResultBlockParam["content"], string | undefined>;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Pages of a transcription: "(p. N)" markers split it; a text without markers is one page. */
function splitPages(text: string): Array<{ page: number | null; text: string }> {
  const parts = text.split(/(?=\(p\. \d+\))/).filter((s) => s.trim().length > 0);
  return parts.map((s) => {
    const m = s.match(/^\(p\. (\d+)\)/);
    return { page: m ? Number(m[1]) : null, text: s };
  });
}

export class LibraryTools {
  private readonly texts = new Map<string, Promise<string | null>>();

  constructor(private readonly lib: ProjectLibrary, private readonly project: Project) {}

  get definitions(): BetaToolUnion[] {
    return LIBRARY_TOOLS;
  }

  private get library(): AttachmentMeta[] {
    const modes = this.lib.modes(this.project);
    return this.project.knowledge.filter((k) => modes.get(k.id) === "library");
  }

  describe(call: ToolCall): string {
    const input = (call.input ?? {}) as Record<string, unknown>;
    switch (call.name) {
      case "read_project_file": {
        const range = typeof input.from_page === "number" ? ` (pages ${input.from_page}${typeof input.to_page === "number" ? `–${input.to_page}` : " on"})` : "";
        return `Reading ${typeof input.name === "string" ? input.name : "a project file"}${range}`;
      }
      case "search_project_files": return `Searching the project's files for "${typeof input.query === "string" ? input.query : ""}"`;
      case "list_project_files": return "Listing the project's files";
      default: return `Using ${call.name}`;
    }
  }

  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolOutput> {
    switch (call.name) {
      case "read_project_file": return this.read(call);
      case "search_project_files": return this.search(call, signal);
      case "list_project_files": return this.list(call);
      default: return { content: [{ type: "text", text: `Unknown tool "${call.name}".` }], isError: true, summary: `Unknown tool ${call.name}` };
    }
  }

  private invalid(call: ToolCall, issue: string): ToolOutput {
    return { content: [{ type: "text", text: `Invalid input for ${call.name}: ${issue}` }], isError: true, summary: `${this.describe(call)}: invalid input` };
  }

  private find(name: string): AttachmentMeta | null {
    const lib = this.library;
    return lib.find((k) => k.name === name) ?? lib.find((k) => k.name.toLowerCase() === name.toLowerCase()) ?? lib.find((k) => k.name.toLowerCase().includes(name.toLowerCase())) ?? null;
  }

  private textOf(meta: AttachmentMeta): Promise<string | null> {
    let p = this.texts.get(meta.id);
    if (!p) {
      p = this.lib.text(meta);
      this.texts.set(meta.id, p);
    }
    return p;
  }

  private notReady(meta: AttachmentMeta): string {
    const st = this.lib.status(meta);
    if (st?.state === "failed") return `"${meta.name}" could not be read page by page; tell the person, who can remove it and add it again, or attach it to this conversation instead.`;
    return `"${meta.name}" is still being read page by page (${(st?.pagesDone ?? 0).toLocaleString("en-US")} of ${(st?.pages ?? meta.pages ?? 0).toLocaleString("en-US")} pages so far). Answer with what you have and say the file is not ready yet; it will be available in a later message.`;
  }

  private async list(call: ToolCall): Promise<ToolOutput> {
    const parsed = ListInput.safeParse(call.input ?? {});
    if (!parsed.success) return this.invalid(call, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const needle = parsed.data.pattern?.toLowerCase() ?? "";
    const files = this.library.filter((k) => !needle || k.name.toLowerCase().includes(needle));
    const text = files.length === 0 ? `No library files${needle ? ` whose name contains "${parsed.data.pattern}"` : ""}.` : this.lib.manifest(this.project, files);
    return { content: [{ type: "text", text }], summary: `Listed ${plural(files.length, "project file")}` };
  }

  private async read(call: ToolCall): Promise<ToolOutput> {
    const parsed = ReadInput.safeParse(call.input);
    if (!parsed.success) return this.invalid(call, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const meta = this.find(parsed.data.name);
    if (!meta) {
      const whole = this.project.knowledge.find((k) => k.name.toLowerCase() === parsed.data.name.toLowerCase());
      const text = whole ? `"${whole.name}" already travels with this conversation: you have it, read it from the conversation.` : `No project file named "${parsed.data.name}". Files on request: ${this.library.map((k) => `"${k.name}"`).join(", ") || "none"}.`;
      return { content: [{ type: "text", text }], isError: !whole, summary: whole ? `${whole.name} is already in the conversation` : `No project file named ${parsed.data.name}` };
    }
    const text = await this.textOf(meta);
    if (text === null) return { content: [{ type: "text", text: this.notReady(meta) }], isError: true, summary: `${meta.name} is not ready yet` };
    const perRead = parsed.data.max_chars ?? LIBRARY.charsPerRead;
    let body = text;
    let label = "";
    if (meta.contentType === "application/pdf" && (parsed.data.from_page || parsed.data.to_page)) {
      const from = parsed.data.from_page ?? 1;
      const to = parsed.data.to_page ?? Number.MAX_SAFE_INTEGER;
      const pages = splitPages(text).filter((pg) => pg.page !== null && pg.page >= from && pg.page <= to);
      if (pages.length === 0) return { content: [{ type: "text", text: `"${meta.name}" has no pages ${from}–${parsed.data.to_page ?? ""} in its transcription (${meta.pages ?? "?"} pages).` }], isError: true, summary: `${meta.name}: pages ${from}–${parsed.data.to_page ?? ""} not found` };
      body = pages.map((pg) => pg.text).join("");
      label = ` pages ${from}${parsed.data.to_page ? `–${parsed.data.to_page}` : " on"},`;
    }
    const start = Math.min(parsed.data.offset ?? 0, body.length);
    const piece = body.slice(start, start + perRead);
    const end = start + piece.length;
    const cut = end < body.length ? `\n[cut at character ${end.toLocaleString("en-US")} of ${body.length.toLocaleString("en-US")}; call read_project_file again with offset: ${end}, or a narrower page range, to continue]` : "";
    const header = `=== ${meta.name}${label}${start > 0 ? ` from character ${start.toLocaleString("en-US")},` : ""} ${meta.pages ? `${meta.pages} pages` : ""} ===`;
    const blocks: ResultBlocks = [{ type: "text", text: `${header}\n${piece}${cut}` }];
    return { content: blocks, summary: `Read ${meta.name}${label ? label.replace(/,$/, "") : ""}` };
  }

  private async search(call: ToolCall, signal: AbortSignal): Promise<ToolOutput> {
    const parsed = SearchInput.safeParse(call.input);
    if (!parsed.success) return this.invalid(call, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    let test: (line: string) => boolean;
    if (parsed.data.regex) {
      try {
        const re = new RegExp(parsed.data.query, "i");
        test = (l) => re.test(l);
      } catch {
        return this.invalid(call, "query is not a valid regular expression");
      }
    } else {
      const needle = parsed.data.query.toLowerCase();
      test = (l) => l.toLowerCase().includes(needle);
    }
    const max = parsed.data.max_results ?? LIBRARY.searchDefaultResults;
    const lines: string[] = [];
    const files = new Set<string>();
    const notReady: string[] = [];
    for (const meta of this.library) {
      if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (lines.length >= max) break;
      const text = await this.textOf(meta);
      if (text === null) { notReady.push(meta.name); continue; }
      let page: number | null = null;
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\(p\. (\d+)\)/);
        if (m) page = Number(m[1]);
        const probe = line.length > 2000 ? line.slice(0, 2000) : line;
        if (!probe.trim() || !test(probe)) continue;
        files.add(meta.name);
        const snippet = probe.trim();
        lines.push(`${meta.name}${page ? ` (p. ${page})` : ""}: ${snippet.length > 200 ? `${snippet.slice(0, 199)}…` : snippet}`);
        if (lines.length >= max) break;
      }
    }
    const head = `${plural(lines.length, "matching line")} in ${plural(files.size, "file")} for "${parsed.data.query}"${lines.length >= max ? ` (first ${max}; narrow the search to see more)` : ""}.${notReady.length > 0 ? ` Not searched, still being read: ${notReady.join(", ")}.` : ""}`;
    return { content: [{ type: "text", text: lines.length > 0 ? `${head}\n${lines.join("\n")}` : head }], summary: `Searched the project's files for "${parsed.data.query}": ${plural(lines.length, "match", "matches")} in ${plural(files.size, "file")}` };
  }
}

/** Several tool sets (ZIPs, the project library) offered to the model as one. */
export class CombinedTools {
  constructor(private readonly sets: Array<{ definitions: BetaToolUnion[]; describe(call: ToolCall): string; execute(call: ToolCall, signal: AbortSignal): Promise<ToolOutput> }>) {}

  get definitions(): BetaToolUnion[] {
    return this.sets.flatMap((s) => s.definitions);
  }

  private owner(name: string) {
    return this.sets.find((s) => s.definitions.some((d) => (d as { name?: string }).name === name));
  }

  describe(call: ToolCall): string {
    return this.owner(call.name)?.describe(call) ?? `Using ${call.name}`;
  }

  execute(call: ToolCall, signal: AbortSignal): Promise<ToolOutput> {
    const set = this.owner(call.name);
    if (!set) return Promise.resolve({ content: [{ type: "text", text: `Unknown tool "${call.name}".` }], isError: true, summary: `Unknown tool ${call.name}` });
    return set.execute(call, signal);
  }
}
