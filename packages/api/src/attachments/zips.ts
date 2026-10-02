import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { z } from "zod";
import type { BetaTool, BetaToolResultBlockParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { AttachmentMeta, SafeLogger, ToolCall, ToolOutput } from "@helixona/core";
import type { AttachmentStore } from "./store.js";
import { INLINE } from "./policy.js";
import { readTables, SpreadsheetError, tablesForModel, XLSX_TYPE } from "./sheets.js";

/**
 * A ZIP attached to a conversation stays one file, like in Claude: the server opens it once, keeps
 * the list of what is inside next to it, and gives the model that list plus three tools (list,
 * search, read) so it reads the archive in parts, as much as the question needs. Nothing inside the
 * ZIP is unpacked into storage; entries are decompressed in memory when a tool asks for them.
 */
export const ZIP_TYPE = "application/zip";
const ZIP_TYPES = new Set([ZIP_TYPE, "application/x-zip-compressed"]);

export function isZipType(contentType: string): boolean {
  return ZIP_TYPES.has(contentType);
}

const MiB = 1024 * 1024;

export const ZIP = {
  /** Bumped when the index format or the manifest wording changes, so older indexes are rebuilt. */
  version: "v1",
  /** Entries listed; beyond this the index stops and says so (a hostile archive cannot fill the memory). */
  maxEntries: 20_000,
  /** Lines of the file list the model receives up front; the rest through `list_zip_files`. */
  manifestMaxLines: 1_500,
  /** Paths one `read_zip_files` call may ask for. */
  maxPathsPerCall: 20,
  /** Characters of one text file per read (the note at the cut says the offset to continue from). */
  textCharsPerFile: 200_000,
  /** Characters of text one read may return in all. */
  textCharsPerCall: 400_000,
  /** PDFs and images one read may return in all (the request also has to fit). */
  bytesPerCall: 20 * MiB,
  /** The API caps an image near 5 MB once base64-encoded. */
  maxImageBytes: 3_500_000,
  /** A text file larger than this is not decoded for a search (nor is it read whole). */
  maxTextBytes: 20 * MiB,
  /** Bytes one search may decode in all. */
  searchMaxBytes: 300 * MiB,
  searchDefaultResults: 40,
  searchMaxResults: 100,
  listDefault: 500,
  listMax: 2_000,
} as const;

export type ZipKind = "pdf" | "sheet" | "text" | "image" | "zip" | "other";

export interface ZipEntryInfo {
  path: string;
  /** Unpacked size when the archive says it; 0 when it does not. */
  size: number;
  kind: ZipKind;
  contentType: string;
}

export interface ZipIndex {
  version: string;
  entries: ZipEntryInfo[];
  files: number;
  readable: number;
  bytes: number;
  /** Extensions the tools cannot read, with how many files of each. */
  otherTypes: Array<[string, number]>;
  truncated: boolean;
}

export class ZipProblem extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ZipProblem";
  }
}

const TEXT_EXTENSIONS: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", json: "application/json", xml: "text/xml", html: "text/html", htm: "text/html",
  yaml: "text/plain", yml: "text/plain", log: "text/plain", ini: "text/plain", cfg: "text/plain", conf: "text/plain", toml: "text/plain", tsv: "text/tab-separated-values",
  js: "text/plain", mjs: "text/plain", cjs: "text/plain", ts: "text/plain", tsx: "text/plain", jsx: "text/plain", py: "text/plain", sql: "text/plain", css: "text/plain", svg: "image/svg+xml",
  eml: "text/plain", ics: "text/plain", vcf: "text/plain", sh: "text/plain", bat: "text/plain", ps1: "text/plain", r: "text/plain", java: "text/plain", c: "text/plain", h: "text/plain",
  cpp: "text/plain", go: "text/plain", rs: "text/plain", rb: "text/plain", php: "text/plain", hl7: "text/plain", ccd: "text/xml", cda: "text/xml",
};
const IMAGE_EXTENSIONS: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

export function kindOf(path: string): { kind: ZipKind; contentType: string; ext: string } {
  const base = path.split("/").pop() ?? path;
  const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
  if (ext === "pdf") return { kind: "pdf", contentType: "application/pdf", ext };
  if (ext === "xlsx") return { kind: "sheet", contentType: XLSX_TYPE, ext };
  if (ext === "csv") return { kind: "sheet", contentType: "text/csv", ext };
  if (ext === "zip") return { kind: "zip", contentType: ZIP_TYPE, ext };
  if (TEXT_EXTENSIONS[ext]) return { kind: "text", contentType: TEXT_EXTENSIONS[ext]!, ext };
  if (IMAGE_EXTENSIONS[ext]) return { kind: "image", contentType: IMAGE_EXTENSIONS[ext]!, ext };
  return { kind: "other", contentType: "application/octet-stream", ext };
}

/** Folder bookkeeping and hidden files are not part of what the person sent. */
function skipped(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return path.startsWith("__MACOSX/") || base.startsWith(".") || base === "Thumbs.db" || base === "desktop.ini" || path.includes("\0");
}

function unpackedSize(entry: JSZip.JSZipObject): number {
  const d = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof d?.uncompressedSize === "number" && d.uncompressedSize >= 0 ? d.uncompressedSize : 0;
}

export async function openZip(bytes: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(bytes);
  } catch {
    throw new ZipProblem("not_a_zip", "could not be opened as a ZIP file");
  }
}

export function indexZip(zip: JSZip): ZipIndex {
  const entries: ZipEntryInfo[] = [];
  const other = new Map<string, number>();
  let truncated = false;
  let bytes = 0;
  let readable = 0;
  const all = Object.values(zip.files).filter((e) => !e.dir && !skipped(e.name)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  for (const e of all) {
    if (entries.length >= ZIP.maxEntries) { truncated = true; break; }
    const { kind, contentType, ext } = kindOf(e.name);
    const size = unpackedSize(e);
    entries.push({ path: e.name, size, kind, contentType });
    bytes += size;
    if (kind === "other" || kind === "zip") other.set(ext ? `.${ext}` : "(no extension)", (other.get(ext ? `.${ext}` : "(no extension)") ?? 0) + 1);
    else readable++;
  }
  return { version: ZIP.version, entries, files: truncated ? all.length : entries.length, readable, bytes, otherTypes: [...other.entries()].sort((a, b) => b[1] - a[1]), truncated };
}

export function formatBytes(n: number): string {
  if (n >= MiB) return `${(n / MiB).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The list the model receives with the ZIP: what is inside and what the tools can read. */
export function zipManifest(name: string, index: ZipIndex): string {
  const by = (k: ZipKind) => index.entries.filter((e) => e.kind === k).length;
  const kinds = [[by("pdf"), "PDF"], [by("sheet"), "spreadsheet"], [by("text"), "text file"], [by("image"), "image"]] as const;
  const kindText = kinds.filter(([n]) => n > 0).map(([n, label]) => plural(n, label)).join(", ");
  const unreadable = index.files - index.readable;
  const otherText = unreadable > 0 ? ` ${plural(unreadable, "file")} of other types cannot be read (${index.otherTypes.slice(0, 8).map(([ext, n]) => `${ext} ${n}`).join(", ")}${index.otherTypes.length > 8 ? ", …" : ""}).` : "";
  const head = `ZIP "${name}": ${plural(index.files, "file")}, ${formatBytes(index.bytes)} unpacked. The tools can read ${index.readable === index.files ? "all of them" : `${index.readable.toLocaleString("en-US")} of them`}${kindText ? ` (${kindText})` : ""}.${otherText}`;
  const lines = index.entries.slice(0, ZIP.manifestMaxLines).map((e) => `${e.path} · ${formatBytes(e.size)}${e.kind === "other" || e.kind === "zip" ? " (not readable)" : ""}`);
  const more = index.entries.length - lines.length + (index.truncated ? index.files - index.entries.length : 0);
  const tail = more > 0 ? `\n… and ${plural(more, "more file")}: use list_zip_files with a prefix or pattern to see them.` : "";
  return `${head}\nFiles (path · size):\n${lines.join("\n")}${tail}`;
}

/** Where the index of a ZIP is kept: next to the file, so it follows its retention and deletion. */
export function zipIndexKey(meta: AttachmentMeta): string {
  return meta.key.replace(/\/[^/]*$/, `/zip-index-${ZIP.version}.json`);
}

/** Opens the ZIP once, when it is attached, and keeps its list next to it. */
export async function prepareZip(store: AttachmentStore, meta: AttachmentMeta, bytes: Buffer): Promise<{ index: ZipIndex; manifest: string }> {
  const zip = await openZip(bytes);
  const index = indexZip(zip);
  if (index.files === 0) throw new ZipProblem("zip_empty", "holds no files");
  const manifest = zipManifest(meta.name, index);
  await store.put(zipIndexKey(meta), Buffer.from(JSON.stringify({ index, manifest }), "utf8"), "application/json").catch(() => undefined);
  return { index, manifest };
}

/** The list kept for a ZIP; an older attachment without one is indexed now. */
export async function loadZipIndex(store: AttachmentStore, meta: AttachmentMeta): Promise<{ index: ZipIndex; manifest: string }> {
  try {
    const parsed = JSON.parse((await store.get(zipIndexKey(meta))).toString("utf8")) as { index: ZipIndex; manifest: string };
    if (parsed.index?.version === ZIP.version && typeof parsed.manifest === "string") return parsed;
  } catch {
    // not prepared yet
  }
  return prepareZip(store, meta, await store.get(meta.key));
}

// ---- The tools ----

const AttachmentField = z.string().min(1).max(200);
const ListInput = z.object({ attachment: AttachmentField, prefix: z.string().max(500).optional(), pattern: z.string().max(200).optional(), limit: z.number().int().min(1).max(ZIP.listMax).optional() }).strict();
const ReadInput = z.object({ attachment: AttachmentField, paths: z.array(z.string().min(1).max(1000)).min(1).max(ZIP.maxPathsPerCall), offset: z.number().int().min(0).optional(), max_chars: z.number().int().min(1000).max(ZIP.textCharsPerCall).optional() }).strict();
const SearchInput = z.object({ attachment: AttachmentField, query: z.string().min(1).max(200), regex: z.boolean().optional(), prefix: z.string().max(500).optional(), max_results: z.number().int().min(1).max(ZIP.searchMaxResults).optional() }).strict();

export const ZIP_TOOLS: BetaTool[] = [
  {
    name: "list_zip_files",
    description: "Lists the files inside a ZIP attached to the conversation, with their sizes. Use it when the list given with the ZIP was cut short, or to look at one folder or one kind of file: `prefix` keeps the paths that start with it (a folder), `pattern` keeps the paths that contain the text, or that match it as a glob when it has * or ?.",
    input_schema: {
      type: "object",
      properties: {
        attachment: { type: "string", description: "The ZIP's file name, as attached" },
        prefix: { type: "string", description: "Keep paths that start with this (a folder, ending in /)" },
        pattern: { type: "string", description: "Keep paths that contain this text, or match this glob (* and ?), case-insensitive" },
        limit: { type: "integer", minimum: 1, maximum: ZIP.listMax, description: `Lines to return (default ${ZIP.listDefault})` },
      },
      required: ["attachment"],
      additionalProperties: false,
    },
  },
  {
    name: "read_zip_files",
    description: `Returns the contents of files inside a ZIP attached to the conversation, up to ${ZIP.maxPathsPerCall} paths per call, exactly as listed. Text, Markdown, CSV, JSON, XML, HTML and similar files come back as text, each cut at \`max_chars\` (${ZIP.textCharsPerFile.toLocaleString("en-US")} by default; the note at the cut gives the offset to continue from). Excel files come back as rows with their Excel row numbers. PDFs up to ${Math.round(INLINE.maxFileBytes / MiB)} MB and ${INLINE.maxFilePages} pages come back as the document itself; images (PNG, JPEG, GIF, WebP) up to 3.5 MB come back as images. Read several files per call rather than one at a time, and read the files the question needs, not the whole archive.`,
    input_schema: {
      type: "object",
      properties: {
        attachment: { type: "string", description: "The ZIP's file name, as attached" },
        paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: ZIP.maxPathsPerCall, description: "Paths inside the ZIP, exactly as listed" },
        offset: { type: "integer", minimum: 0, description: "Characters to skip at the start of each text file, to continue a long one" },
        max_chars: { type: "integer", minimum: 1000, maximum: ZIP.textCharsPerCall, description: "Characters of text to return per file" },
      },
      required: ["attachment", "paths"],
      additionalProperties: false,
    },
  },
  {
    name: "search_zip_files",
    description: "Finds which files inside a ZIP mention something, so you can read the right ones: a case-insensitive search for `query` (plain text, or a regular expression when `regex` is true) over the text-like files (text, Markdown, CSV, JSON, XML, HTML and similar; not PDFs, Excel files or images). Returns the matching lines with their file and line number. Use `prefix` to search one folder.",
    input_schema: {
      type: "object",
      properties: {
        attachment: { type: "string", description: "The ZIP's file name, as attached" },
        query: { type: "string", minLength: 1, maxLength: 200, description: "Text to find (case-insensitive), or a regular expression when regex is true" },
        regex: { type: "boolean", description: "Treat query as a regular expression" },
        prefix: { type: "string", description: "Search only paths that start with this" },
        max_results: { type: "integer", minimum: 1, maximum: ZIP.searchMaxResults, description: `Matching lines to return (default ${ZIP.searchDefaultResults})` },
      },
      required: ["attachment", "query"],
      additionalProperties: false,
    },
  },
];

type ResultBlocks = Exclude<BetaToolResultBlockParam["content"], string | undefined>;

interface OpenedZip {
  meta: AttachmentMeta;
  zip: JSZip;
  index: ZipIndex;
}

export interface ZipToolsOptions {
  store: AttachmentStore;
  log: SafeLogger;
  /** The ZIPs attached to the conversation, oldest first. */
  zips: AttachmentMeta[];
  /** Characters of rows the model gets for a spreadsheet inside the ZIP. */
  sheetChars: number;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function names(paths: string[]): string {
  const shown = paths.slice(0, 3).map(basename);
  return paths.length > 3 ? `${shown.join(", ")} and ${paths.length - 3} more` : shown.join(", ");
}

/** True when the bytes look binary (a text extension on a file that is not text). */
function looksBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8000);
  return head.includes(0);
}

/**
 * The three tools over the ZIPs of one conversation. One instance per turn: an archive opened for
 * one call stays open (in memory) for the next calls of the same turn.
 */
export class ZipTools {
  private readonly opened = new Map<string, Promise<OpenedZip>>();

  constructor(private readonly opts: ZipToolsOptions) {}

  get definitions(): BetaToolUnion[] {
    return ZIP_TOOLS;
  }

  describe(call: ToolCall): string {
    const input = (call.input ?? {}) as Record<string, unknown>;
    const zip = typeof input.attachment === "string" ? input.attachment : "the ZIP";
    switch (call.name) {
      case "read_zip_files": {
        const paths = Array.isArray(input.paths) ? (input.paths as unknown[]).map(String) : [];
        return paths.length > 0 ? `Reading ${plural(paths.length, "file")} from ${zip}: ${names(paths)}` : `Reading files from ${zip}`;
      }
      case "search_zip_files":
        return `Searching ${zip} for "${typeof input.query === "string" ? input.query : ""}"`;
      case "list_zip_files":
        return `Listing the files in ${zip}${typeof input.prefix === "string" && input.prefix ? ` under ${input.prefix}` : ""}`;
      default:
        return `Using ${call.name}`;
    }
  }

  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolOutput> {
    switch (call.name) {
      case "read_zip_files": return this.read(call, signal);
      case "search_zip_files": return this.search(call, signal);
      case "list_zip_files": return this.list(call);
      default: return { content: [{ type: "text", text: `Unknown tool "${call.name}".` }], isError: true, summary: `Unknown tool ${call.name}` };
    }
  }

  private resolve(name: string): AttachmentMeta | null {
    const zips = this.opts.zips;
    const exact = [...zips].reverse().find((z) => z.name === name) ?? [...zips].reverse().find((z) => z.name.toLowerCase() === name.toLowerCase());
    if (exact) return exact;
    return zips.length === 1 ? zips[0]! : null;
  }

  private open(meta: AttachmentMeta): Promise<OpenedZip> {
    let p = this.opened.get(meta.id);
    if (!p) {
      p = (async () => {
        const bytes = await this.opts.store.get(meta.key);
        const zip = await openZip(bytes);
        const index = indexZip(zip);
        return { meta, zip, index };
      })();
      this.opened.set(meta.id, p);
    }
    return p;
  }

  private notFound(name: string): ToolOutput {
    const list = this.opts.zips.map((z) => `"${z.name}"`).join(", ");
    return { content: [{ type: "text", text: `No ZIP named "${name}" is attached to this conversation. Attached: ${list || "none"}.` }], isError: true, summary: `No ZIP named ${name}` };
  }

  private invalid(call: ToolCall, issue: string): ToolOutput {
    return { content: [{ type: "text", text: `Invalid input for ${call.name}: ${issue}` }], isError: true, summary: `${this.describe(call)}: invalid input` };
  }

  private async list(call: ToolCall): Promise<ToolOutput> {
    const parsed = ListInput.safeParse(call.input);
    if (!parsed.success) return this.invalid(call, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const meta = this.resolve(parsed.data.attachment);
    if (!meta) return this.notFound(parsed.data.attachment);
    const { index } = await this.open(meta);
    const prefix = parsed.data.prefix?.toLowerCase() ?? "";
    const pattern = parsed.data.pattern ? (/[*?]/.test(parsed.data.pattern) ? globToRegExp(parsed.data.pattern) : null) : null;
    const needle = parsed.data.pattern && !pattern ? parsed.data.pattern.toLowerCase() : null;
    const limit = parsed.data.limit ?? ZIP.listDefault;
    const matches = index.entries.filter((e) => {
      const p = e.path.toLowerCase();
      if (prefix && !p.startsWith(prefix)) return false;
      if (pattern && !pattern.test(e.path) && !pattern.test(basename(e.path))) return false;
      if (needle && !p.includes(needle)) return false;
      return true;
    });
    const shown = matches.slice(0, limit);
    const lines = shown.map((e) => `${e.path} · ${formatBytes(e.size)}${e.kind === "other" || e.kind === "zip" ? " (not readable)" : ""}`);
    const text = `${plural(matches.length, "file")} in "${meta.name}"${prefix ? ` under ${parsed.data.prefix}` : ""}${parsed.data.pattern ? ` matching ${parsed.data.pattern}` : ""}${matches.length > shown.length ? ` (first ${shown.length} shown; narrow with prefix or pattern, or raise limit)` : ""}${index.truncated ? ` (the archive holds more than ${ZIP.maxEntries.toLocaleString("en-US")} files; only the first ${ZIP.maxEntries.toLocaleString("en-US")} are listed)` : ""}:\n${lines.join("\n")}`;
    return { content: [{ type: "text", text }], summary: `Listed ${plural(matches.length, "file")} in ${meta.name}${prefix ? ` under ${parsed.data.prefix}` : ""}` };
  }

  private async read(call: ToolCall, signal: AbortSignal): Promise<ToolOutput> {
    const parsed = ReadInput.safeParse(call.input);
    if (!parsed.success) return this.invalid(call, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const meta = this.resolve(parsed.data.attachment);
    if (!meta) return this.notFound(parsed.data.attachment);
    const { zip, index } = await this.open(meta);
    const perFile = Math.min(parsed.data.max_chars ?? ZIP.textCharsPerFile, ZIP.textCharsPerCall);
    const offset = parsed.data.offset ?? 0;
    const blocks: ResultBlocks = [];
    let charsLeft = ZIP.textCharsPerCall;
    let bytesLeft = ZIP.bytesPerCall;
    const read: string[] = [];
    const missing: string[] = [];
    for (const rawPath of [...new Set(parsed.data.paths)]) {
      if (signal.aborted) throw abortError();
      const path = rawPath.replace(/^\.?\//, "");
      const info = index.entries.find((e) => e.path === path) ?? index.entries.find((e) => e.path.toLowerCase() === path.toLowerCase());
      const entry = info ? zip.file(info.path) : null;
      if (!info || !entry) {
        const alike = index.entries.filter((e) => basename(e.path).toLowerCase() === basename(path).toLowerCase()).map((e) => e.path);
        blocks.push({ type: "text", text: `=== ${meta.name} › ${rawPath} ===\nNot in the ZIP.${alike.length > 0 ? ` Did you mean: ${alike.slice(0, 5).join(", ")}?` : " Check the path against the list."}` });
        missing.push(rawPath);
        continue;
      }
      const header = `=== ${meta.name} › ${info.path} (${formatBytes(info.size)}) ===`;
      if (info.kind === "other" || info.kind === "zip") {
        blocks.push({ type: "text", text: `${header}\nThis type (${kindOf(info.path).ext ? `.${kindOf(info.path).ext}` : "no extension"}) cannot be read here.` });
        continue;
      }
      if (info.kind === "pdf" || info.kind === "image") {
        const cap = info.kind === "pdf" ? INLINE.maxFileBytes : ZIP.maxImageBytes;
        if (info.size > cap) {
          blocks.push({ type: "text", text: `${header}\n${info.kind === "pdf" ? `This PDF is too large to read from inside the ZIP (${formatBytes(info.size)}; the limit is ${Math.round(cap / MiB)} MB). Ask the person to attach it to the chat on its own: there it is read page by page.` : `This image is too large to read from inside the ZIP (${formatBytes(info.size)}; the limit is 3.5 MB).`}` });
          continue;
        }
        const bytes = await entry.async("nodebuffer");
        if (bytes.length > bytesLeft) {
          blocks.push({ type: "text", text: `${header}\nNot returned: this call already carries ${Math.round(ZIP.bytesPerCall / MiB)} MB of documents. Ask for this file in another call.` });
          continue;
        }
        if (info.kind === "pdf") {
          const pages = await pdfPages(bytes);
          if (pages !== null && pages > INLINE.maxFilePages) {
            blocks.push({ type: "text", text: `${header}\nThis PDF has ${pages} pages, more than the ${INLINE.maxFilePages} that can be read from inside the ZIP. Ask the person to attach it to the chat on its own: there it is read page by page.` });
            continue;
          }
          blocks.push({ type: "text", text: `${header}${pages ? ` ${pages} pages.` : ""}` });
          blocks.push({ type: "document", title: info.path, source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } });
        } else {
          blocks.push({ type: "text", text: header });
          blocks.push({ type: "image", source: { type: "base64", media_type: info.contentType as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: bytes.toString("base64") } });
        }
        bytesLeft -= bytes.length;
        read.push(info.path);
        continue;
      }
      // Text and spreadsheets come back as text.
      if (info.size > ZIP.maxTextBytes) {
        blocks.push({ type: "text", text: `${header}\nThis file is too large to read here (${formatBytes(info.size)}; the limit is ${Math.round(ZIP.maxTextBytes / MiB)} MB). Ask the person for a smaller file.` });
        continue;
      }
      const bytes = await entry.async("nodebuffer");
      let text: string;
      if (info.kind === "sheet") {
        try {
          text = tablesForModel(info.path, await readTables(info.contentType, bytes), Math.min(perFile, this.opts.sheetChars));
        } catch (e) {
          blocks.push({ type: "text", text: `${header}\n${e instanceof SpreadsheetError ? `Could not be read as a spreadsheet: ${e.message}` : "Could not be read as a spreadsheet."}` });
          continue;
        }
      } else {
        if (looksBinary(bytes)) {
          blocks.push({ type: "text", text: `${header}\nThis file is binary, not text; it cannot be read here.` });
          continue;
        }
        text = bytes.toString("utf8").replace(/^﻿/, "");
      }
      const total = text.length;
      const take = Math.min(perFile, charsLeft);
      if (take <= 0) {
        blocks.push({ type: "text", text: `${header}\nNot returned: this call already carries ${ZIP.textCharsPerCall.toLocaleString("en-US")} characters of text. Ask for this file in another call.` });
        continue;
      }
      const start = Math.min(offset, total);
      const piece = text.slice(start, start + take);
      const end = start + piece.length;
      const cut = end < total ? `\n[cut at character ${end.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}; call read_zip_files with offset: ${end} to continue]` : "";
      const from = start > 0 ? ` From character ${start.toLocaleString("en-US")}.` : "";
      blocks.push({ type: "text", text: `${header}${from}\n${piece}${cut}` });
      charsLeft -= piece.length;
      read.push(info.path);
    }
    const ok = read.length > 0;
    const summary = ok ? `Read ${plural(read.length, "file")} from ${meta.name}: ${names(read)}${missing.length > 0 ? ` (${plural(missing.length, "path")} not found)` : ""}` : `Nothing readable among ${plural(parsed.data.paths.length, "path")} in ${meta.name}`;
    this.opts.log.info("zip_read", { count: read.length, status: ok ? "ok" : "empty" });
    return { content: blocks, isError: !ok, summary };
  }

  private async search(call: ToolCall, signal: AbortSignal): Promise<ToolOutput> {
    const parsed = SearchInput.safeParse(call.input);
    if (!parsed.success) return this.invalid(call, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const meta = this.resolve(parsed.data.attachment);
    if (!meta) return this.notFound(parsed.data.attachment);
    const { zip, index } = await this.open(meta);
    let test: (line: string) => boolean;
    if (parsed.data.regex) {
      try {
        const re = new RegExp(parsed.data.query, "i");
        test = (line) => re.test(line);
      } catch {
        return this.invalid(call, "query is not a valid regular expression");
      }
    } else {
      const needle = parsed.data.query.toLowerCase();
      test = (line) => line.toLowerCase().includes(needle);
    }
    const prefix = parsed.data.prefix?.toLowerCase() ?? "";
    const max = parsed.data.max_results ?? ZIP.searchDefaultResults;
    const candidates = index.entries.filter((e) => (e.kind === "text" || e.contentType === "text/csv") && (!prefix || e.path.toLowerCase().startsWith(prefix)));
    const lines: string[] = [];
    const files = new Set<string>();
    let searched = 0;
    let skippedLarge = 0;
    let bytesLeft = ZIP.searchMaxBytes;
    let stopped = false;
    for (const e of candidates) {
      if (signal.aborted) throw abortError();
      if (lines.length >= max) { stopped = true; break; }
      if (e.size > ZIP.maxTextBytes) { skippedLarge++; continue; }
      if (e.size > bytesLeft) { stopped = true; break; }
      const entry = zip.file(e.path);
      if (!entry) continue;
      const bytes = await entry.async("nodebuffer");
      bytesLeft -= bytes.length;
      if (looksBinary(bytes)) continue;
      searched++;
      const text = bytes.toString("utf8");
      let n = 0;
      for (const line of text.split(/\r?\n/)) {
        n++;
        const probe = line.length > 2000 ? line.slice(0, 2000) : line;
        if (!test(probe)) continue;
        files.add(e.path);
        const snippet = probe.trim();
        lines.push(`${e.path}:${n}: ${snippet.length > 200 ? `${snippet.slice(0, 199)}…` : snippet}`);
        if (lines.length >= max) break;
      }
    }
    const head = `${plural(lines.length, "matching line")} in ${plural(files.size, "file")} for "${parsed.data.query}" in "${meta.name}" (searched ${plural(searched, "text file")}${skippedLarge > 0 ? `, ${skippedLarge} skipped as too large` : ""}${stopped ? `; stopped at ${max} results or the size limit, narrow the search to see more` : ""}). PDFs, Excel files and images are not searched: read them.`;
    this.opts.log.info("zip_search", { count: lines.length, status: "ok" });
    return { content: [{ type: "text", text: lines.length > 0 ? `${head}\n${lines.join("\n")}` : head }], summary: `Searched ${meta.name} for "${parsed.data.query}": ${plural(lines.length, "match", "matches")} in ${plural(files.size, "file")}` };
  }
}

async function pdfPages(bytes: Buffer): Promise<number | null> {
  try {
    return (await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })).getPageCount();
  } catch {
    return null;
  }
}

function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}
