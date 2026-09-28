import { PDFDocument } from "pdf-lib";
import { classifyError, estimateUsd, type AttachmentMeta, type Catalog, type Effort, type LlmProvider, type SafeLogger, type StreamParams, type UsageSummary } from "@helixona/core";
import type { AttachmentStore } from "./store.js";
import { pageLabel, planChunks } from "./planner.js";
import { READ, readingPrefix } from "./policy.js";

/**
 * Instructions for the model that transcribes a large file a few pages at a time. The transcription
 * replaces the pages in the conversation, so it has to be complete and exact rather than short.
 */
export const READER_SYSTEM = `You transcribe pages of medical records for the clinicians of an integrative medicine clinic. They will use your transcription instead of the pages while they prepare a patient's chart, so a missing or wrong value can mislead a clinical decision: be complete and exact rather than brief.

- Laboratory results: put every result in a Markdown table with the columns Date | Test | Result | Units | Reference range | Flag | Page. Use the collection date as printed and repeat it on every row. Copy the test name, result, units and range exactly as printed; the flag is what the report prints (H, L, A, critical) or empty. One row per result, normal results included.
- Reports (imaging, pathology, procedures, consultations, visit notes, discharge summaries): the date, the kind of report and the author or facility when shown, then the findings, impression, assessment and plan, as close to verbatim as you can.
- Lists (medications, allergies, problems or diagnoses, immunizations, vital signs): copy them with their dates, doses and units.
- Patient identifiers (name, date of birth, record number): copy them once, the first time they appear, not on every page.
- Start each page with a line "(p. N)" using the page numbers given in the request, and keep the pages in order.
- Write only what is on the pages. Do not interpret, summarize or comment. Write [illegible] or [cut off] where you cannot read something. For a blank page, a fax cover or a page with only a signature, write one line saying so.`;

/** The request for one part. It starts with "Transcribe page(s) A–B", which the fake model in tests recognises. */
export function readerInstruction(name: string, from: number, to: number, total: number | null): string {
  const range = from === to ? `page ${from}` : `pages ${from}–${to}`;
  const of = total ? ` of ${total}` : "";
  return `Transcribe ${range}${of} of the file "${name}". The excerpt attached starts at page ${from} of the file: number the pages from there.`;
}

/** Bounded concurrency, shared by every conversation of this server: reading holds large files in memory. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<{ resolve: () => void; reject: (e: unknown) => void; signal?: AbortSignal; onAbort: () => void }> = [];
  constructor(private readonly max: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    if (this.active < this.max) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(abortError());
        },
      };
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      this.waiting.push(entry);
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        // The slot passes straight to the next waiter.
        next.signal?.removeEventListener("abort", next.onAbort);
        next.resolve();
      } else {
        this.active--;
      }
    };
  }
}

export interface ReaderConfig {
  store: AttachmentStore;
  provider: LlmProvider;
  catalog: Catalog;
  log: SafeLogger;
  /** Catalog id of the model that transcribes. */
  modelId: string;
  effort: Effort;
  /** Parts read at the same time across the server. */
  chunkConcurrency: number;
  /** Files open (in memory) at the same time across the server. */
  fileConcurrency: number;
  maxTokens?: number;
  /** Waits between retries when the model is busy (tests shorten them). */
  retryDelaysMs?: number[];
}

export interface ReadOptions {
  signal: AbortSignal;
  conversationId: string;
  /** Pages finished so far (read, cached or given up) out of the file's pages. */
  onProgress: (pagesDone: number, pagesTotal: number | null) => void;
  /** What each request to the model cost, as it finishes (so a stopped reading is still counted). */
  onUsage?: (usage: UsageSummary) => void;
}

export interface FileReading {
  text: string;
  /** Pages of the file, as counted while reading. */
  pages: number | null;
  /** Page labels ("9", "41–48") that could not be read. */
  failedPages: string[];
  usage: UsageSummary;
  /** Parts transcribed now, and parts found already transcribed. */
  partsRead: number;
  partsCached: number;
  /** Whether the whole reading came from the cache. */
  cached: boolean;
}

interface Part {
  from: number;
  to: number;
  text: string | null;
  note?: string;
}

type Outcome = { kind: "ok"; text: string } | { kind: "split" } | { kind: "failed"; note: string };

const EMPTY_USAGE: UsageSummary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0 };

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const pad = (n: number) => String(n).padStart(4, "0");

/**
 * Reads PDFs that are too large to send whole: splits them into parts of a few pages (pdf-lib), has a
 * second model transcribe each part, and keeps every transcribed part next to the file, so a retry,
 * a later turn or a reload does not pay for it again. Nothing leaves the clinic's AWS account except
 * the pages sent to the model, over the same Claude API the chat uses.
 */
export class DocumentReader {
  private readonly parts: Semaphore;
  private readonly files: Semaphore;

  constructor(private readonly cfg: ReaderConfig) {
    this.parts = new Semaphore(Math.max(1, cfg.chunkConcurrency));
    this.files = new Semaphore(Math.max(1, cfg.fileConcurrency));
  }

  get modelId(): string {
    return this.cfg.modelId;
  }

  /** The complete transcription of a file, if it was read before. */
  async cached(meta: AttachmentMeta): Promise<string | null> {
    return this.getText(`${readingPrefix(meta.key)}full.md`);
  }

  async read(meta: AttachmentMeta, opts: ReadOptions): Promise<FileReading> {
    const full = await this.cached(meta);
    if (full !== null) {
      opts.onProgress(meta.pages ?? 0, meta.pages);
      return { text: full, pages: meta.pages, failedPages: [], usage: { ...EMPTY_USAGE }, partsRead: 0, partsCached: 0, cached: true };
    }
    const release = await this.files.acquire(opts.signal);
    try {
      return await this.readFile(meta, opts);
    } finally {
      release();
    }
  }

  private async readFile(meta: AttachmentMeta, opts: ReadOptions): Promise<FileReading> {
    const prefix = readingPrefix(meta.key);
    const bytes = await this.cfg.store.get(meta.key);
    let src: PDFDocument | null = null;
    let pages = meta.pages;
    try {
      src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
      // A damaged file can load and still have no page tree.
      pages = src.getPageCount();
    } catch {
      src = null;
    }
    const usage: UsageSummary = { ...EMPTY_USAGE };
    const counts = { read: 0, cached: 0 };
    let done = 0;
    const progress = (n: number) => {
      done += n;
      opts.onProgress(pages ? Math.min(done, pages) : done, pages);
    };
    const ctx = { meta, prefix, bytes, src, pages, usage, counts, progress, opts };

    let parts: Part[];
    if (src && !src.isEncrypted && pages && pages > 0) {
      const ranges = planChunks(bytes.length, pages, READ.chunkPages, READ.chunkTargetBytes);
      parts = (await Promise.all(ranges.map(([from, to]) => this.readRange(ctx, from, to)))).flat();
    } else {
      // pdf-lib cannot split it (password-protected, or a structure it does not understand): the whole
      // file goes in one request if it fits one.
      parts = await this.readWhole(ctx);
    }
    parts.sort((a, b) => a.from - b.from);

    const failed = parts.filter((p) => p.text === null);
    const text = parts
      .map((p) => (p.text !== null ? p.text : `(p. ${pageLabel([[p.from, p.to]])}) [${p.note ?? "These pages could not be read."}]`))
      .join("\n\n");
    usage.estimatedUsd = estimateUsd(this.cfg.catalog, this.cfg.modelId, usage);
    if (failed.length === 0) await this.putText(`${prefix}full.md`, text);
    return { text, pages, failedPages: failed.map((p) => pageLabel([[p.from, p.to]])), usage, partsRead: counts.read, partsCached: counts.cached, cached: false };
  }

  private async readRange(ctx: ReadContext, from: number, to: number): Promise<Part[]> {
    const key = `${ctx.prefix}p${pad(from)}-${pad(to)}.md`;
    const cached = await this.getText(key);
    if (cached !== null) {
      ctx.counts.cached++;
      ctx.progress(to - from + 1);
      return [{ from, to, text: cached }];
    }
    // A part that had to be split before goes straight to its halves (their transcriptions are kept).
    const splitMarker = `${key}.split`;
    const splitBefore = to > from && (await this.exists(splitMarker));
    const outcome: Outcome = splitBefore
      ? { kind: "split" }
      : await this.withPartSlot(ctx.opts.signal, async () => {
          const chunk = await buildChunk(ctx.src!, from, to);
          if (chunk.length > READ.chunkMaxBytes) return to > from ? ({ kind: "split" } as const) : ({ kind: "failed", note: "This page is too large to read (over 20 MB)." } as const);
          return this.transcribe(ctx, chunk, from, to);
        });
    if (outcome.kind === "split") {
      if (!splitBefore) await this.putText(splitMarker, "", "text/plain");
      const mid = Math.floor((from + to) / 2);
      const [a, b] = await Promise.all([this.readRange(ctx, from, mid), this.readRange(ctx, mid + 1, to)]);
      return [...a, ...b];
    }
    ctx.progress(to - from + 1);
    if (outcome.kind === "ok") {
      await this.putText(key, outcome.text);
      ctx.counts.read++;
      return [{ from, to, text: outcome.text }];
    }
    return [{ from, to, text: null, note: outcome.note }];
  }

  private async readWhole(ctx: ReadContext): Promise<Part[]> {
    const to = ctx.pages ?? 1;
    const key = `${ctx.prefix}whole.md`;
    const cached = await this.getText(key);
    if (cached !== null) {
      ctx.counts.cached++;
      ctx.progress(to);
      return [{ from: 1, to, text: cached }];
    }
    if (ctx.bytes.length > READ.chunkMaxBytes) {
      ctx.progress(to);
      const why = ctx.src?.isEncrypted ? "is password-protected" : "could not be opened for splitting";
      return [{ from: 1, to, text: null, note: `This file ${why} and is too large to read whole. Open it, print it to a new PDF (or save a copy without a password) and attach that.` }];
    }
    const outcome = await this.withPartSlot(ctx.opts.signal, () => this.transcribe(ctx, ctx.bytes, 1, to));
    ctx.progress(to);
    if (outcome.kind === "ok") {
      await this.putText(key, outcome.text);
      ctx.counts.read++;
      return [{ from: 1, to, text: outcome.text }];
    }
    const note = outcome.kind === "failed" ? outcome.note : "This file could not be read.";
    return [{ from: 1, to, text: null, note: ctx.src?.isEncrypted ? `${note} The file is password-protected; save a copy without a password and attach that.` : note }];
  }

  private async withPartSlot(signal: AbortSignal, fn: () => Promise<Outcome>): Promise<Outcome> {
    const release = await this.parts.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** One request to the model for pages `from`–`to`; retries when the service is busy. */
  private async transcribe(ctx: ReadContext, chunk: Uint8Array, from: number, to: number): Promise<Outcome> {
    const params: StreamParams = {
      model: this.cfg.modelId,
      maxTokens: this.cfg.maxTokens ?? 32_000,
      effort: this.cfg.effort,
      system: [{ type: "text", text: READER_SYSTEM }],
      messages: [
        {
          role: "user",
          content: [
            { type: "document", title: `${ctx.meta.name} (${pageLabel([[from, to]])})`, source: { type: "base64", media_type: "application/pdf", data: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64") } },
            { type: "text", text: readerInstruction(ctx.meta.name, from, to, ctx.pages) },
          ],
        },
      ],
    };
    // Busy or rate-limited: wait longer each time (the SDK already retried once, honouring retry-after),
    // with jitter so the parts read in parallel do not all come back at the same moment.
    const delays = this.cfg.retryDelaysMs ?? [5_000, 15_000, 30_000, 60_000];
    for (let attempt = 1; ; attempt++) {
      try {
        const handle = this.cfg.provider.stream(params, { signal: ctx.opts.signal, conversationId: ctx.opts.conversationId });
        for await (const _event of handle) {
          // The transcription is taken from the final message.
        }
        const msg = await handle.finalMessage();
        const spent = {
          inputTokens: msg.usage?.input_tokens ?? 0,
          outputTokens: msg.usage?.output_tokens ?? 0,
          cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: msg.usage?.cache_creation_input_tokens ?? 0,
        };
        ctx.usage.inputTokens += spent.inputTokens;
        ctx.usage.outputTokens += spent.outputTokens;
        ctx.usage.cacheReadTokens += spent.cacheReadTokens;
        ctx.usage.cacheWriteTokens += spent.cacheWriteTokens;
        ctx.opts.onUsage?.({ ...spent, estimatedUsd: estimateUsd(this.cfg.catalog, this.cfg.modelId, spent) });
        if (msg.stop_reason === "refusal") return { kind: "failed", note: "The model declined to read these pages." };
        const text = msg.content
          .flatMap((b) => (b.type === "text" ? [b.text] : []))
          .join("")
          .trim();
        if (msg.stop_reason === "max_tokens") return to > from ? { kind: "split" } : { kind: "ok", text: `${text}\n\n[The transcription of this page was cut short.]` };
        if (!text) return to > from ? { kind: "split" } : { kind: "failed", note: "Nothing could be read on this page." };
        return { kind: "ok", text };
      } catch (e) {
        const c = classifyError(e);
        if (ctx.opts.signal.aborted || c.kind === "aborted") throw e;
        if (c.kind === "availability" && attempt <= delays.length) {
          await sleep(Math.round(delays[attempt - 1]! * (0.75 + Math.random() * 0.5)), ctx.opts.signal);
          continue;
        }
        // A request the API refuses may hold one bad page: try the halves before giving up.
        if (c.kind === "bug" && to > from) return { kind: "split" };
        this.cfg.log.warn("attachment_read_part_failed", { conversationId: ctx.opts.conversationId, errorClass: c.errorClass, status: c.status ?? undefined, reason: c.kind, attempt, pages: to - from + 1 });
        return {
          kind: "failed",
          note: c.kind === "availability" ? "The reading service was busy; send the message again to retry these pages." : "These pages could not be read.",
        };
      }
    }
  }

  /** A saved transcription, or null. A storage error counts as "not saved": the pages are read again. */
  private async getText(key: string): Promise<string | null> {
    try {
      const head = await this.cfg.store.head(key);
      if (!head) return null;
      return (await this.cfg.store.get(key)).toString("utf8");
    } catch (e) {
      this.cfg.log.warn("attachment_reading_lookup_failed", { errorClass: e instanceof Error ? e.name : "unknown" });
      return null;
    }
  }

  private async exists(key: string): Promise<boolean> {
    try {
      return (await this.cfg.store.head(key)) !== null;
    } catch (e) {
      this.cfg.log.warn("attachment_reading_lookup_failed", { errorClass: e instanceof Error ? e.name : "unknown" });
      return false;
    }
  }

  /** Keeps a transcription (or a marker) next to the file. A storage error only costs the reuse: this answer still has the text. */
  private async putText(key: string, text: string, contentType = "text/markdown; charset=utf-8"): Promise<void> {
    try {
      await this.cfg.store.put(key, Buffer.from(text, "utf8"), contentType);
    } catch (e) {
      this.cfg.log.warn("attachment_reading_save_failed", { errorClass: e instanceof Error ? e.name : "unknown" });
    }
  }
}

interface ReadContext {
  meta: AttachmentMeta;
  prefix: string;
  bytes: Buffer;
  src: PDFDocument | null;
  pages: number | null;
  usage: UsageSummary;
  counts: { read: number; cached: number };
  progress: (pages: number) => void;
  opts: ReadOptions;
}

/** A new PDF holding pages `from`–`to` (1-based, inclusive) of `src`. */
export async function buildChunk(src: PDFDocument, from: number, to: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const indices = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  const copied = await doc.copyPages(src, indices);
  for (const page of copied) doc.addPage(page);
  return doc.save();
}
