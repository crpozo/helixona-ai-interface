import type { BetaTool, BetaToolResultBlockParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import { classifyError, estimateUsd, type AttachmentMeta, type Catalog, type Effort, type LlmProvider, type Project, type SafeLogger, type StreamParams, type ToolCall, type ToolContext, type ToolOutput, type UsageSummary } from "@helixona/core";
import { readingPrefix } from "./policy.js";
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
  charsPerRead: 80_000,
  maxCharsPerRead: 300_000,
  /** Pages of a PDF one read returns when no range is asked for, and the size of the pieces a review works on. */
  pagesPerRead: 40,
  /** Characters per piece for files without pages (text, spreadsheets). */
  charsPerPiece: 120_000,
  searchDefaultResults: 40,
  searchMaxResults: 100,
  /** Pieces summarized or reviewed at the same time. */
  concurrency: 6,
  /** Pages one review may cover; beyond that the model is asked to name the files. */
  reviewMaxPages: 6_000,
  /** Characters of findings a review returns at most before they are condensed. */
  reviewMaxChars: 240_000,
  /** Bumped when the digest instructions change, so older digests are redone. */
  digestVersion: "v1",
} as const;

/** Instructions for the worker model that digests a piece of a file (a few pages) for the project's list. */
const DIGEST_PIECE_SYSTEM = `You prepare working notes on documents for the staff of a medical clinic (records requests, audits, appeals, claims). You receive one piece of a document (a range of pages) and write compact notes that let a colleague know what is in it without opening it: the kind of document, the parties (payer, provider, patient initials only), dates and date ranges, amounts, claim or case numbers, what is requested, found, decided or missing, and anything that looks like a deadline, a discrepancy or a risk. Cite page numbers in parentheses. Plain sentences and short bullet lists, at most 200 words. Do not add advice or interpretation.`;
/** Instructions for the one-paragraph digest of a whole file, made from the notes of its pieces. */
const DIGEST_FILE_SYSTEM = `You receive the working notes of the pieces of one document, in order, and write one paragraph of at most 120 words that says what the document is, who it involves, the period it covers, and the two or three most important facts in it, with page numbers in parentheses. No bullets, no advice.`;
/** Instructions for a reviewer that reads one piece of a file against a question. */
const REVIEW_SYSTEM = `You review documents for the staff of a medical clinic. You receive one piece of a document (a range of pages) and a question or task. Report everything in these pages that bears on it: facts, dates, amounts, names of parties (patient initials only), decisions, requests, discrepancies, missing items; quote short key phrases exactly when wording matters. Cite the page in parentheses after each item. Be complete rather than brief, but do not repeat the same fact twice and do not summarize what is not relevant. If nothing in these pages bears on the question, answer exactly: Nothing relevant.`;
/** Instructions for condensing many findings into fewer, without losing facts or citations. */
const REDUCE_SYSTEM = `You receive review findings from several pieces of several documents, each with file names and page citations, and merge them into one coherent set of notes: group by document and topic, keep every distinct fact, date, amount and citation, remove repetition, and keep the file name and pages with each item. Do not add interpretation.`;

interface Job {
  pagesDone: number;
  pages: number | null;
  phase: "reading" | "summarizing";
  promise: Promise<void>;
}

export interface LibraryOptions {
  store: AttachmentStore;
  reader: DocumentReader;
  /** The worker model for digests and reviews (the same as the reader's). */
  provider: LlmProvider;
  catalog: Catalog;
  effort: Effort;
  repos: Repos;
  log: SafeLogger;
  sheetChars: number;
  now?: () => Date;
  /** Waits between retries when the model is busy (shortened in tests). */
  retryDelaysMs?: number[];
}

/** A piece of a file: a range of pages of a transcription, or a slice of a text. */
export interface Piece {
  label: string;
  from: number | null;
  to: number | null;
  text: string;
}

/** Cuts a file's text into pieces a worker model handles comfortably. */
export function piecesOf(text: string, isPdf: boolean): Piece[] {
  if (isPdf) {
    const pages = splitPages(text).filter((p) => p.page !== null);
    if (pages.length === 0) return text.trim() ? [{ label: "", from: null, to: null, text }] : [];
    const out: Piece[] = [];
    for (let i = 0; i < pages.length; i += LIBRARY.pagesPerRead) {
      const slice = pages.slice(i, i + LIBRARY.pagesPerRead);
      out.push({ label: `pp. ${slice[0]!.page}–${slice[slice.length - 1]!.page}`, from: slice[0]!.page, to: slice[slice.length - 1]!.page, text: slice.map((p) => p.text).join("") });
    }
    return out;
  }
  const out: Piece[] = [];
  for (let i = 0; i < text.length; i += LIBRARY.charsPerPiece) out.push({ label: text.length > LIBRARY.charsPerPiece ? `part ${out.length + 1}` : "", from: null, to: null, text: text.slice(i, i + LIBRARY.charsPerPiece) });
  return out;
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping the order of the results. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}

export class ProjectLibrary {
  private readonly jobs = new Map<string, Job>();
  private readonly digests = new Map<string, { text: string | null; at: number }>();
  private readonly now: () => Date;

  constructor(private readonly opts: LibraryOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /** The worker model's id (digests and reviews are priced and audited under it). */
  get workerModel(): string {
    return this.opts.reader.modelId;
  }

  /**
   * One request to the worker model: a system instruction and a text, the answer as text. Busy
   * answers are retried with growing waits, like the reader's.
   */
  async complete(system: string, text: string, signal: AbortSignal, onUsage?: (u: UsageSummary) => void, maxTokens = 4_000): Promise<string> {
    const params: StreamParams = { model: this.opts.reader.modelId, maxTokens, effort: this.opts.effort, system: [{ type: "text", text: system }], messages: [{ role: "user", content: [{ type: "text", text }] }] };
    const delays = this.opts.retryDelaysMs ?? [5_000, 15_000, 30_000, 60_000];
    for (let attempt = 1; ; attempt++) {
      try {
        const handle = this.opts.provider.stream(params, { signal, conversationId: "library" });
        for await (const _ev of handle) {
          // the answer is taken from the final message
        }
        const msg = await handle.finalMessage();
        const spent = { inputTokens: msg.usage?.input_tokens ?? 0, outputTokens: msg.usage?.output_tokens ?? 0, cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0, cacheWriteTokens: msg.usage?.cache_creation_input_tokens ?? 0 };
        onUsage?.({ ...spent, estimatedUsd: estimateUsd(this.opts.catalog, this.opts.reader.modelId, spent) });
        if (msg.stop_reason === "refusal") return "";
        return msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
      } catch (e) {
        const c = classifyError(e);
        if (signal.aborted || c.kind === "aborted") throw e;
        if (c.kind === "availability" && attempt <= delays.length) {
          await new Promise((r) => setTimeout(r, Math.round(delays[attempt - 1]! * (0.75 + Math.random() * 0.5))));
          continue;
        }
        throw e;
      }
    }
  }

  private digestKey(meta: AttachmentMeta): string {
    return `${readingPrefix(meta.key)}digest-${LIBRARY.digestVersion}.md`;
  }

  /** The digest of a file (one paragraph, then notes per piece), or null when it is not made yet. Kept in memory for a while. */
  async digestOf(meta: AttachmentMeta): Promise<string | null> {
    const cached = this.digests.get(meta.id);
    if (cached && this.now().getTime() - cached.at < 10 * 60_000 && cached.text !== null) return cached.text;
    const text = await this.opts.reader.getText(this.digestKey(meta));
    this.digests.set(meta.id, { text, at: this.now().getTime() });
    return text;
  }

  /** Writes the digest of a file from its text: notes per piece, then one paragraph for the whole. */
  private async makeDigest(meta: AttachmentMeta, text: string, signal: AbortSignal, onUsage: (u: UsageSummary) => void): Promise<void> {
    const pieces = piecesOf(text, meta.contentType === "application/pdf");
    if (pieces.length === 0) return;
    const notes = await mapLimit(pieces, LIBRARY.concurrency, async (p) => {
      const note = await this.complete(DIGEST_PIECE_SYSTEM, `Document: "${meta.name}"${p.label ? ` (${p.label})` : ""}

${p.text}`, signal, onUsage, 1_200);
      return `## ${p.label || "Whole file"}
${note || "(no notes)"}`;
    });
    const joined = notes.join("\n\n");
    const summary = pieces.length === 1 && (notes[0]?.length ?? 0) < 900 ? notes[0]!.replace(/^## [^\n]*\n/, "") : await this.complete(DIGEST_FILE_SYSTEM, `Document: "${meta.name}"

${joined.slice(0, 200_000)}`, signal, onUsage, 800);
    const digest = `${summary || "(no summary)"}

${joined}`;
    await this.opts.store.put(this.digestKey(meta), Buffer.from(digest, "utf8"), "text/markdown; charset=utf-8");
    this.digests.set(meta.id, { text: digest, at: this.now().getTime() });
  }

  /** The split of a project's files: whole (with every message) or library (on request). */
  modes(p: Project): Map<string, KnowledgeMode> {
    return planKnowledge(p.knowledge);
  }

  /** The reading status of a file as the project page shows it: live progress while a job runs. */
  status(meta: AttachmentMeta): AttachmentMeta["reading"] {
    const job = this.jobs.get(meta.id);
    if (job) return { state: "pending", pages: job.pages ?? meta.pages, pagesDone: job.pagesDone, phase: job.phase };
    return meta.reading;
  }

  /** Starts preparing every library file that is not ready yet (after a restart, or when added). Does not wait. */
  ensureAll(p: Project): void {
    const modes = this.modes(p);
    for (const k of p.knowledge) {
      if (modes.get(k.id) === "library" && k.reading?.state !== "done" && !this.jobs.has(k.id)) this.start(p, k);
    }
  }

  /** Whether a library file is ready for the tools (read, and digested). */
  ready(meta: AttachmentMeta): boolean {
    return this.status(meta)?.state === "done";
  }

  /** Resolves when no reading is running (tests). */
  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs.values()].map((j) => j.promise.catch(() => undefined)));
  }

  private start(p: Project, meta: AttachmentMeta): void {
    const job: Job = { pagesDone: 0, pages: meta.pages, phase: "reading", promise: Promise.resolve() };
    const userId = meta.uploadedBy ?? p.ownerId;
    const spent: UsageSummary = { ...EMPTY_USAGE };
    const onUsage = (u: UsageSummary) => { spent.inputTokens += u.inputTokens; spent.outputTokens += u.outputTokens; spent.cacheReadTokens += u.cacheReadTokens; spent.cacheWriteTokens += u.cacheWriteTokens; spent.estimatedUsd += u.estimatedUsd; };
    const started = this.now().getTime();
    const signal = new AbortController().signal;
    job.promise = (async () => {
      let reading: AttachmentMeta["reading"];
      try {
        let text: string;
        let failedPages: string[] = [];
        if (meta.contentType === "application/pdf") {
          const r = await this.opts.reader.read(meta, { signal, conversationId: `project:${p.id}`, onProgress: (done, total) => { job.pagesDone = done; if (total !== null) job.pages = total; }, onUsage });
          text = r.text;
          failedPages = r.failedPages;
          job.pages = r.pages ?? job.pages;
        } else {
          text = (await this.text(meta)) ?? "";
        }
        // Then the digest: what the file is, for the list the model sees with every message.
        job.phase = "summarizing";
        job.pagesDone = job.pages ?? job.pagesDone;
        let digest = true;
        try {
          await this.makeDigest(meta, text, signal, onUsage);
        } catch (e) {
          digest = false;
          this.opts.log.warn("project_file_digest_failed", { errorClass: e instanceof Error ? e.name : "unknown" });
        }
        reading = { state: "done", pages: job.pages ?? meta.pages, pagesDone: job.pages ?? meta.pages ?? 0, digest, ...(failedPages.length > 0 ? { failedPages } : {}) };
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

  /** One line of the list: name, size and status. */
  private line(k: AttachmentMeta): string {
    const st = this.status(k);
    const pages = st?.pages ?? k.pages;
    const size = pages ? `${pages.toLocaleString("en-US")} pages` : `${Math.max(1, Math.round(k.size / 1024)).toLocaleString("en-US")} KB`;
    const state = st?.state === "done" ? (st.failedPages?.length ? `ready (pages ${st.failedPages.join(", ")} could not be read)` : "ready") : st?.state === "failed" ? "could not be read" : st?.phase === "summarizing" ? "being summarized (ready in a moment)" : `being read (${(st?.pagesDone ?? 0).toLocaleString("en-US")} of ${pages?.toLocaleString("en-US") ?? "?"} pages so far)`;
    return `${k.name} · ${size} · ${state}`;
  }

  /** The list the model receives with every message of a project that has library files, each with its one-paragraph digest. */
  async manifest(p: Project, library: AttachmentMeta[]): Promise<string> {
    const total = library.reduce((n, k) => n + (this.status(k)?.pages ?? k.pages ?? 0), 0);
    const lines = await mapLimit(library, 8, async (k) => {
      const line = this.line(k);
      const digest = this.ready(k) ? await this.digestOf(k).catch(() => null) : null;
      const first = digest?.split("\n\n")[0]?.trim();
      return first ? `${line}\n    ${first.replace(/\s+/g, " ")}` : line;
    });
    return `Project "${p.name}" library: ${library.length === 1 ? "1 file" : `${library.length} files`}${total > 0 ? `, ${total.toLocaleString("en-US")} pages` : ""}, available on request, not in this conversation until you read them. Each file has a one-paragraph digest under its name; the full notes come with read_project_file and digest: true. For a question that spans many files or the whole set, use review_project_files, which reads every piece for you.\nFiles (name · size · status):\n${lines.join("\n")}`;
  }

  /**
   * A review: every piece of the chosen files is read by the worker model against the question, in
   * parallel, and the findings come back merged with file and page citations. This is how a broad
   * request over a large project ("analyze everything") is answered without filling the conversation.
   */
  async review(p: Project, files: AttachmentMeta[], question: string, signal: AbortSignal, maxChars: number, progress?: (text: string) => void): Promise<{ text: string; usage: UsageSummary; pieces: number; pages: number; files: number }> {
    const usage: UsageSummary = { ...EMPTY_USAGE };
    const onUsage = (u: UsageSummary) => { usage.inputTokens += u.inputTokens; usage.outputTokens += u.outputTokens; usage.cacheReadTokens += u.cacheReadTokens; usage.cacheWriteTokens += u.cacheWriteTokens; usage.estimatedUsd += u.estimatedUsd; };
    const work: Array<{ meta: AttachmentMeta; piece: Piece }> = [];
    for (const meta of files) {
      const text = await this.text(meta);
      if (text === null) continue;
      for (const piece of piecesOf(text, meta.contentType === "application/pdf")) work.push({ meta, piece });
    }
    const pages = files.reduce((n, k) => n + (this.status(k)?.pages ?? k.pages ?? 0), 0);
    let done = 0;
    const report = () => progress?.(`Reviewing ${files.length === 1 ? "1 file" : `${files.length} files`}${pages > 0 ? ` (${pages.toLocaleString("en-US")} pages)` : ""} for "${question.length > 60 ? `${question.slice(0, 59)}…` : question}": ${done} of ${work.length} parts done`);
    report();
    const findings = await mapLimit(work, LIBRARY.concurrency, async ({ meta, piece }) => {
      const out = await this.complete(REVIEW_SYSTEM, `Question or task: ${question}

Document: "${meta.name}"${piece.label ? ` (${piece.label})` : ""}

${piece.text}`, signal, onUsage, 3_000);
      done++;
      report();
      if (!out || /^nothing relevant\.?$/i.test(out.trim())) return null;
      return `### ${meta.name}${piece.label ? ` (${piece.label})` : ""}
${out}`;
    });
    let merged = findings.filter((f): f is string => f !== null);
    let condensed = 0;
    // Too much for the conversation: condense in groups until it fits, keeping file names and pages.
    while (merged.join("\n\n").length > Math.min(maxChars, LIBRARY.reviewMaxChars) && merged.length > 1) {
      condensed++;
      progress?.(`Condensing ${merged.length} sets of findings (round ${condensed})`);
      const groups: string[][] = [];
      let cur: string[] = [];
      let size = 0;
      for (const f of merged) {
        if (size + f.length > 120_000 && cur.length > 0) { groups.push(cur); cur = []; size = 0; }
        cur.push(f);
        size += f.length;
      }
      if (cur.length > 0) groups.push(cur);
      if (groups.length === merged.length) {
        // Every finding is already alone in its group: condense each in turn instead.
        merged = await mapLimit(merged, LIBRARY.concurrency, async (f) => (await this.complete(REDUCE_SYSTEM, `Question or task: ${question}

${f.slice(0, 160_000)}`, signal, onUsage, 4_000)) || f.slice(0, 20_000));
      } else {
        merged = await mapLimit(groups, LIBRARY.concurrency, async (g) => (await this.complete(REDUCE_SYSTEM, `Question or task: ${question}

${g.join("\n\n")}`, signal, onUsage, 6_000)) || g.join("\n\n").slice(0, 40_000));
      }
      if (condensed >= 4) break;
    }
    const covered = `Reviewed ${files.length === 1 ? "1 file" : `${files.length} files`}${pages > 0 ? `, ${pages.toLocaleString("en-US")} pages` : ""} in ${work.length} parts for: ${question}
${merged.length === 0 ? "Nothing in them bears on it." : `Findings (file and pages cited; ${findings.filter((f) => f !== null).length} parts had something relevant${condensed > 0 ? `, condensed ${condensed === 1 ? "once" : `${condensed} times`}` : ""}):`}`;
    return { text: `${covered}

${merged.join("\n\n")}`.slice(0, maxChars), usage, pieces: work.length, pages, files: files.length };
  }

  tools(p: Project): LibraryTools {
    return new LibraryTools(this, p);
  }
}

const NameField = z.string().min(1).max(200);
const ListInput = z.object({ pattern: z.string().max(200).optional() }).strict();
const ReadInput = z.object({ name: NameField, from_page: z.number().int().min(1).optional(), to_page: z.number().int().min(1).optional(), offset: z.number().int().min(0).optional(), max_chars: z.number().int().min(1000).max(LIBRARY.maxCharsPerRead).optional(), digest: z.boolean().optional() }).strict();
const ReviewInput = z.object({ question: z.string().min(3).max(2000), files: z.array(NameField).max(200).optional() }).strict();
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
    description: `Returns the contents of one library file of the project: a PDF as its page-by-page transcription (every page starts with "(p. N)"), a spreadsheet as rows with their row numbers, a text file as it is. A PDF comes ${LIBRARY.pagesPerRead} pages at a time: give from_page and to_page for the range you need (search_project_files tells you which pages matter). Long text is cut at max_chars (${LIBRARY.charsPerRead.toLocaleString("en-US")} by default) with the offset to continue. Read what the question needs, not whole files; cite the file and page of what you use.`,
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The file name, exactly as listed" },
        from_page: { type: "integer", minimum: 1, description: "First page to return (PDFs)" },
        to_page: { type: "integer", minimum: 1, description: "Last page to return (PDFs)" },
        offset: { type: "integer", minimum: 0, description: "Characters to skip (to continue a long text)" },
        max_chars: { type: "integer", minimum: 1000, maximum: LIBRARY.maxCharsPerRead, description: "Characters to return" },
        digest: { type: "boolean", description: "Return the file's digest (a paragraph, then notes per range of pages) instead of its text" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "review_project_files",
    description: `Reads every page of the project's library files (or of the files named) against a question or task, in parallel, and returns the merged findings with file and page citations. This is the way to answer a broad request over a large project ("analyze everything", "find every X across the records", "prepare the full review"): one call per distinct question, then write the answer from the findings. It takes a minute or more for thousands of pages and reads up to ${LIBRARY.reviewMaxPages.toLocaleString("en-US")} pages per call; beyond that, name the files. Phrase the question as the extraction you need ("every date of service, CPT code and amount billed, with the claim number" rather than "analyze").`,
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 3, maxLength: 2000, description: "What to look for or extract, precisely" },
        files: { type: "array", items: { type: "string" }, maxItems: 200, description: "File names to review; all library files when omitted" },
      },
      required: ["question"],
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
      case "review_project_files": return `Reviewing the project's files for "${typeof input.question === "string" ? (input.question.length > 60 ? `${input.question.slice(0, 59)}…` : input.question) : ""}"`;
      default: return `Using ${call.name}`;
    }
  }

  async execute(call: ToolCall, signal: AbortSignal, ctx?: ToolContext): Promise<ToolOutput> {
    switch (call.name) {
      case "read_project_file": return this.read(call, ctx);
      case "review_project_files": return this.reviewCall(call, signal, ctx);
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
    const text = files.length === 0 ? `No library files${needle ? ` whose name contains "${parsed.data.pattern}"` : ""}.` : await this.lib.manifest(this.project, files);
    return { content: [{ type: "text", text }], summary: `Listed ${plural(files.length, "project file")}` };
  }

  private async read(call: ToolCall, ctx?: ToolContext): Promise<ToolOutput> {
    const parsed = ReadInput.safeParse(call.input);
    if (!parsed.success) return this.invalid(call, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const meta = this.find(parsed.data.name);
    if (!meta) {
      const whole = this.project.knowledge.find((k) => k.name.toLowerCase() === parsed.data.name.toLowerCase());
      const text = whole ? `"${whole.name}" already travels with this conversation: you have it, read it from the conversation.` : `No project file named "${parsed.data.name}". Files on request: ${this.library.map((k) => `"${k.name}"`).join(", ") || "none"}.`;
      return { content: [{ type: "text", text }], isError: !whole, summary: whole ? `${whole.name} is already in the conversation` : `No project file named ${parsed.data.name}` };
    }
    if (parsed.data.digest) {
      const digest = this.lib.ready(meta) ? await this.lib.digestOf(meta) : null;
      if (!digest) return { content: [{ type: "text", text: this.lib.ready(meta) ? `"${meta.name}" has no digest (it could not be summarized); read its pages instead.` : this.notReady(meta) }], isError: true, summary: `${meta.name}: no digest yet` };
      return { content: [{ type: "text", text: `=== Digest of ${meta.name} (${meta.pages ? `${meta.pages} pages` : "text"}) ===\n${digest.slice(0, ctx?.maxChars ?? LIBRARY.maxCharsPerRead)}` }], summary: `Read the digest of ${meta.name}` };
    }
    const text = await this.textOf(meta);
    if (text === null) return { content: [{ type: "text", text: this.notReady(meta) }], isError: true, summary: `${meta.name} is not ready yet` };
    // What one read may return: the cap asked for, and no more than the conversation has room for.
    const perRead = Math.min(parsed.data.max_chars ?? LIBRARY.charsPerRead, ctx?.maxChars ?? LIBRARY.maxCharsPerRead);
    let body = text;
    let label = "";
    let next = "";
    if (meta.contentType === "application/pdf") {
      const all = splitPages(text);
      const total = all.filter((pg) => pg.page !== null).length;
      // Without a range, a long PDF comes a window of pages at a time, so one read never floods the conversation.
      const from = parsed.data.from_page ?? 1;
      const to = parsed.data.to_page ?? (parsed.data.from_page || total > LIBRARY.pagesPerRead ? from + LIBRARY.pagesPerRead - 1 : Number.MAX_SAFE_INTEGER);
      const pages = all.filter((pg) => pg.page !== null && pg.page >= from && pg.page <= to);
      if (pages.length === 0) return { content: [{ type: "text", text: `"${meta.name}" has no pages ${from}–${parsed.data.to_page ?? ""} in its transcription (${meta.pages ?? "?"} pages).` }], isError: true, summary: `${meta.name}: pages ${from}–${parsed.data.to_page ?? ""} not found` };
      body = pages.map((pg) => pg.text).join("");
      const last = pages[pages.length - 1]!.page!;
      label = pages.length === total ? "" : ` pages ${from}–${last},`;
      if (last < (all[all.length - 1]?.page ?? last)) next = `\n[pages ${last + 1} on follow; call read_project_file with from_page: ${last + 1}${parsed.data.to_page ? "" : ", or search_project_files to find the pages that matter"}]`;
    }
    const start = Math.min(parsed.data.offset ?? 0, body.length);
    const piece = body.slice(start, start + perRead);
    const end = start + piece.length;
    const cut = end < body.length ? `\n[cut at character ${end.toLocaleString("en-US")} of ${body.length.toLocaleString("en-US")}; call read_project_file again with offset: ${end}, or a narrower page range, to continue]` : next;
    const header = `=== ${meta.name}${label}${start > 0 ? ` from character ${start.toLocaleString("en-US")},` : ""} ${meta.pages ? `${meta.pages} pages` : ""} ===`;
    const blocks: ResultBlocks = [{ type: "text", text: `${header}\n${piece}${cut}` }];
    return { content: blocks, summary: `Read ${meta.name}${label ? label.replace(/,$/, "") : ""}` };
  }

  private async reviewCall(call: ToolCall, signal: AbortSignal, ctx?: ToolContext): Promise<ToolOutput> {
    const parsed = ReviewInput.safeParse(call.input);
    if (!parsed.success) return this.invalid(call, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const lib = this.library;
    let files = lib;
    if (parsed.data.files && parsed.data.files.length > 0) {
      const missing: string[] = [];
      files = parsed.data.files.flatMap((n) => { const m = this.find(n); if (!m) missing.push(n); return m ? [m] : []; });
      if (files.length === 0) return { content: [{ type: "text", text: `None of these files is in the project's library: ${missing.join(", ")}. Files on request: ${lib.map((k) => `"${k.name}"`).join(", ") || "none"}.` }], isError: true, summary: "Review: files not found" };
    }
    const notReady = files.filter((k) => !this.lib.ready(k));
    files = files.filter((k) => this.lib.ready(k));
    if (files.length === 0) return { content: [{ type: "text", text: `No file is ready to review yet: ${notReady.map((k) => this.notReady(k)).join(" ")}` }], isError: true, summary: "Review: no file ready yet" };
    const pages = files.reduce((n, k) => n + (this.lib.status(k)?.pages ?? k.pages ?? 0), 0);
    if (pages > LIBRARY.reviewMaxPages) return { content: [{ type: "text", text: `These files have ${pages.toLocaleString("en-US")} pages; one review covers up to ${LIBRARY.reviewMaxPages.toLocaleString("en-US")}. Name the files for this question (list_project_files shows them), in two or more calls.` }], isError: true, summary: `Review: too many pages (${pages.toLocaleString("en-US")})` };
    const r = await this.lib.review(this.project, files, parsed.data.question, signal, ctx?.maxChars ?? LIBRARY.reviewMaxChars, ctx?.progress);
    const note = notReady.length > 0 ? `

Not reviewed, still being prepared: ${notReady.map((k) => k.name).join(", ")}.` : "";
    return { content: [{ type: "text", text: `${r.text}${note}` }], usage: r.usage, summary: `Reviewed ${r.files === 1 ? "1 file" : `${r.files} files`}${r.pages > 0 ? ` (${r.pages.toLocaleString("en-US")} pages)` : ""} for "${parsed.data.question.length > 60 ? `${parsed.data.question.slice(0, 59)}…` : parsed.data.question}"` };
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
  constructor(private readonly sets: Array<{ definitions: BetaToolUnion[]; describe(call: ToolCall): string; execute(call: ToolCall, signal: AbortSignal, ctx?: ToolContext): Promise<ToolOutput> }>) {}

  get definitions(): BetaToolUnion[] {
    return this.sets.flatMap((s) => s.definitions);
  }

  private owner(name: string) {
    return this.sets.find((s) => s.definitions.some((d) => (d as { name?: string }).name === name));
  }

  describe(call: ToolCall): string {
    return this.owner(call.name)?.describe(call) ?? `Using ${call.name}`;
  }

  execute(call: ToolCall, signal: AbortSignal, ctx?: ToolContext): Promise<ToolOutput> {
    const set = this.owner(call.name);
    if (!set) return Promise.resolve({ content: [{ type: "text", text: `Unknown tool "${call.name}".` }], isError: true, summary: `Unknown tool ${call.name}` });
    return set.execute(call, signal, ctx);
  }
}
