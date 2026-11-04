import JSZip from "jszip";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { z } from "zod";
import type { BetaTool, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ulid, type AttachmentMeta, type SafeLogger, type ToolCall, type ToolContext, type ToolOutput } from "@helixona/core";
import type { AttachmentStore } from "./store.js";
import { isImageType, safeName } from "./policy.js";

/**
 * Packages: one PDF that opens with a cover and index, then the summary the assistant wrote, then the
 * chosen documents appended whole and unchanged (and a ZIP with the same pieces as separate files).
 * The model builds one with the `build_package` tool; the person can change what is in it afterwards
 * without the model. Everything stays in the clinic's storage, under the conversation.
 */

export type PackageSource = "summary" | "chat" | "project";

export interface PackageItem {
  /** The attachment id, or "summary". */
  id: string;
  name: string;
  source: PackageSource;
  contentType: string;
  /** Pages of the original when known. */
  pages: number | null;
  /** In the package, in this order; the rest are available to add. */
  included: boolean;
  /** First page in the merged PDF (included items, once built). */
  startPage: number | null;
  /** Pages the item takes in the merged PDF. */
  mergedPages: number | null;
  /** Why the original is not in the PDF as itself (it still goes in the ZIP). */
  note?: string;
}

export interface PackageManifest {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** The summary, as Markdown. */
  summary: string;
  items: PackageItem[];
  /** Pages and bytes of the merged PDF. */
  pages: number;
  bytes: number;
  /** Everything the package could hold when it was built (object keys included); kept on the server only. */
  candidates?: PackageCandidate[];
}

/** What the client sees: the manifest without the object keys. */
export type PublicPackage = Omit<PackageManifest, "candidates">;

export function publicManifest(m: PackageManifest): PublicPackage {
  const { candidates: _c, ...rest } = m;
  return rest;
}

export interface PackageCandidate extends AttachmentMeta {
  source: "chat" | "project";
}

export function packageKey(conversationId: string, packageId: string, file: "package.pdf" | "summary.pdf" | "manifest.json"): string {
  return `conversations/${conversationId}/packages/${packageId}/${file}`;
}

/** Documents the package can carry as pages: PDFs, images and plain text (not spreadsheets or ZIPs). */
export function canPackage(contentType: string): boolean {
  return contentType === "application/pdf" || isImageType(contentType) || contentType === "text/plain" || contentType === "text/markdown";
}

const MAX_DOCUMENTS = 40;

// ---------------------------------------------------------------- Rendering Markdown to pages

const PAGE = { width: 612, height: 792, margin: 56 } as const;
const GOLD = rgb(0.84, 0.73, 0.51);
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.42, 0.42, 0.42);
const RULE = rgb(0.85, 0.8, 0.7);

interface Fonts { body: PDFFont; bold: PDFFont; italic: PDFFont; sans: PDFFont }

async function loadFonts(doc: PDFDocument): Promise<Fonts> {
  return { body: await doc.embedFont(StandardFonts.TimesRoman), bold: await doc.embedFont(StandardFonts.TimesRomanBold), italic: await doc.embedFont(StandardFonts.TimesRomanItalic), sans: await doc.embedFont(StandardFonts.Helvetica) };
}

/** The standard fonts know WinAnsi only: typographic punctuation is kept, anything else is dropped. */
function safeText(s: string): string {
  return s
    .replace(/\t/g, " ")
    .replace(/[‐-‒]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•…€]/g, "");
}

/** Inline Markdown to plain words: emphasis, code and links keep their text. */
function inlinePlain(s: string): string {
  return safeText(
    s
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, "$1$2")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

class Writer {
  page!: PDFPage;
  y = 0;
  readonly pages: PDFPage[] = [];
  constructor(readonly doc: PDFDocument, readonly fonts: Fonts, readonly brand: string) {
    this.newPage();
  }
  get width(): number {
    return PAGE.width - PAGE.margin * 2;
  }
  newPage(): void {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.pages.push(this.page);
    this.page.drawRectangle({ x: 0, y: PAGE.height - 5, width: PAGE.width, height: 5, color: GOLD });
    this.page.drawText(safeText(this.brand), { x: PAGE.margin, y: PAGE.height - PAGE.margin + 4, size: 8.5, font: this.fonts.sans, color: rgb(0.54, 0.45, 0.28) });
    this.y = PAGE.height - PAGE.margin - 30;
  }
  need(h: number): void {
    if (this.y - h < PAGE.margin + 24) this.newPage();
  }
  gap(h: number): void {
    this.y -= h;
  }
  /** Draws wrapped text; `x` is the left edge within the margins. */
  text(s: string, opts: { size: number; font: PDFFont; color?: ReturnType<typeof rgb>; x?: number; width?: number; lineHeight?: number; after?: number }): void {
    const lines = wrap(s, opts.font, opts.size, opts.width ?? this.width - (opts.x ?? 0));
    const lh = opts.lineHeight ?? opts.size * 1.42;
    for (const line of lines) {
      this.need(lh);
      this.page.drawText(line, { x: PAGE.margin + (opts.x ?? 0), y: this.y - opts.size, size: opts.size, font: opts.font, color: opts.color ?? INK });
      this.y -= lh;
    }
    this.y -= opts.after ?? 0;
  }
  rule(): void {
    this.page.drawLine({ start: { x: PAGE.margin, y: this.y }, end: { x: PAGE.width - PAGE.margin, y: this.y }, thickness: 0.6, color: RULE });
  }
}

function renderMarkdown(w: Writer, markdown: string): void {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let table: string[][] = [];
  const flushPara = () => {
    if (para.length === 0) return;
    w.text(inlinePlain(para.join(" ")), { size: 11.5, font: w.fonts.body, after: 7 });
    para = [];
  };
  const flushTable = () => {
    if (table.length === 0) return;
    const cols = Math.max(...table.map((r) => r.length));
    const colW = w.width / Math.max(1, cols);
    table.forEach((row, ri) => {
      const cells = row.map((c) => wrap(inlinePlain(c), ri === 0 ? w.fonts.bold : w.fonts.body, 9.5, colW - 6));
      const h = Math.max(...cells.map((c) => c.length)) * 12.5 + 6;
      w.need(h);
      cells.forEach((cl, ci) => cl.forEach((line, li) => w.page.drawText(line, { x: PAGE.margin + ci * colW, y: w.y - 10 - li * 12.5, size: 9.5, font: ri === 0 ? w.fonts.bold : w.fonts.body, color: INK })));
      w.y -= h;
      w.page.drawLine({ start: { x: PAGE.margin, y: w.y + 1 }, end: { x: PAGE.width - PAGE.margin, y: w.y + 1 }, thickness: 0.4, color: ri === 0 ? RULE : rgb(0.92, 0.92, 0.92) });
    });
    w.y -= 8;
    table = [];
  };
  let first = true;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^\s*\|/.test(line)) {
      flushPara();
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue; // the header separator
      table.push(line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim()));
      continue;
    }
    flushTable();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flushPara();
      const level = h[1]!.length;
      const text = inlinePlain(h[2]!);
      if (level === 1) {
        if (!first) w.gap(10);
        w.text(text, { size: 24, font: w.fonts.body, after: 4 });
      } else if (level === 2) {
        w.gap(first ? 4 : 10);
        w.need(30);
        w.text(text.toUpperCase().split("").join(" ").replace(/ /g, " "), { size: 9.5, font: w.fonts.sans, color: rgb(0.54, 0.45, 0.28), after: 0 });
        w.y += 2;
        w.rule();
        w.gap(10);
      } else {
        w.gap(6);
        w.text(text, { size: 12, font: w.fonts.bold, after: 3 });
      }
      first = false;
      continue;
    }
    const li = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const indent = Math.min(3, Math.floor(li[1]!.length / 2)) * 14;
      const numbered = /^\s*\d/.test(line);
      const marker = numbered ? `${/^\s*(\d+)/.exec(line)![1]}.` : "•";
      w.need(16);
      w.page.drawText(marker, { x: PAGE.margin + indent + 4, y: w.y - 11.5, size: 11.5, font: w.fonts.body, color: INK });
      w.text(inlinePlain(li[2]!), { size: 11.5, font: w.fonts.body, x: indent + 20, after: 3 });
      first = false;
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      w.text(inlinePlain(q[1]!), { size: 11.5, font: w.fonts.italic, x: 14, color: MUTED, after: 6 });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushPara();
      w.gap(4);
      w.rule();
      w.gap(10);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      continue;
    }
    para.push(line.trim());
    first = false;
  }
  flushPara();
  flushTable();
}

/** The Markdown's first level-1 heading, for the file name and the cover. */
export function markdownTitle(markdown: string): string | null {
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m ? inlinePlain(m[1]!) : null;
}

// ---------------------------------------------------------------- Building

export interface BuildInput {
  store: AttachmentStore;
  conversationId: string;
  packageId: string;
  title: string;
  summary: string;
  /** Everything the package may hold, in catalog order. */
  candidates: PackageCandidate[];
  /** Ids of the documents to include, in order. */
  selection: string[];
  /** A line under the title on the cover (the clinic, the date). */
  subtitle: string;
  createdAt?: string;
  now?: () => Date;
}

interface Piece {
  item: PackageItem;
  /** Pages ready to copy into the final document (null: a placeholder page is drawn). */
  doc: PDFDocument | null;
  image?: { bytes: Buffer; kind: "png" | "jpg" };
  text?: string;
}

async function loadPdf(bytes: Buffer): Promise<PDFDocument | null> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    if (doc.isEncrypted) return null;
    return doc;
  } catch {
    return null;
  }
}

/** Builds the merged PDF and the summary-only PDF, stores both with the manifest, and returns the manifest. */
export async function buildPackage(input: BuildInput): Promise<PackageManifest> {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const brand = "HELIXONA";
  const candidatesById = new Map(input.candidates.map((c) => [c.id, c]));
  const chosen = input.selection.map((id) => candidatesById.get(id)).filter((c): c is PackageCandidate => !!c).slice(0, MAX_DOCUMENTS);

  // 1. The summary, as its own document (also stored on its own for the ZIP).
  const summaryDoc = await PDFDocument.create();
  const summaryWriter = new Writer(summaryDoc, await loadFonts(summaryDoc), `${brand} · ${input.title}`);
  renderMarkdown(summaryWriter, input.summary.trim() || `# ${input.title}`);
  const summaryBytes = Buffer.from(await summaryDoc.save());

  // 2. Each document: PDFs as they are; images and text as pages; anything else as a note.
  const pieces: Piece[] = [];
  for (const c of chosen) {
    const item: PackageItem = { id: c.id, name: c.name, source: c.source, contentType: c.contentType, pages: c.pages, included: true, startPage: null, mergedPages: null };
    try {
      const bytes = await input.store.get(c.key);
      if (c.contentType === "application/pdf") {
        const doc = await loadPdf(bytes);
        if (doc) pieces.push({ item, doc });
        else pieces.push({ item: { ...item, note: "This PDF is protected or damaged and could not be merged; it is in the ZIP as it is." }, doc: null });
      } else if (c.contentType === "image/png" || c.contentType === "image/jpeg") {
        pieces.push({ item, doc: null, image: { bytes, kind: c.contentType === "image/png" ? "png" : "jpg" } });
      } else if (c.contentType === "text/plain" || c.contentType === "text/markdown") {
        pieces.push({ item, doc: null, text: bytes.toString("utf8").slice(0, 400_000) });
      } else {
        pieces.push({ item: { ...item, note: "This file type cannot be shown as pages; it is in the ZIP as it is." }, doc: null });
      }
    } catch {
      pieces.push({ item: { ...item, note: "This file is no longer available." }, doc: null });
    }
  }

  // 3. Assemble: a cover (built last, once page numbers are known) + summary + documents.
  const out = await PDFDocument.create();
  out.setTitle(input.title);
  out.setProducer("Helixona Assistant");
  const fonts = await loadFonts(out);
  // Cover pages: one per 30 entries.
  const entries = 1 + pieces.length;
  const coverPages = Math.max(1, Math.ceil(entries / 30));
  for (let i = 0; i < coverPages; i++) out.addPage([PAGE.width, PAGE.height]);
  let pageNo = coverPages + 1;
  const summaryStart = pageNo;
  for (const p of await out.copyPages(summaryDoc, summaryDoc.getPageIndices())) {
    out.addPage(p);
    pageNo++;
  }
  const summaryPages = pageNo - summaryStart;
  for (const piece of pieces) {
    piece.item.startPage = pageNo;
    if (piece.doc) {
      const copied = await out.copyPages(piece.doc, piece.doc.getPageIndices());
      for (const p of copied) out.addPage(p);
      piece.item.mergedPages = copied.length;
    } else if (piece.image) {
      const img = piece.image.kind === "png" ? await out.embedPng(piece.image.bytes) : await out.embedJpg(piece.image.bytes);
      const page = out.addPage([PAGE.width, PAGE.height]);
      const box = { w: PAGE.width - PAGE.margin * 2, h: PAGE.height - PAGE.margin * 2 - 20 };
      const scale = Math.min(box.w / img.width, box.h / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      page.drawText(safeText(piece.item.name), { x: PAGE.margin, y: PAGE.height - PAGE.margin + 2, size: 9, font: fonts.sans, color: MUTED });
      page.drawImage(img, { x: (PAGE.width - w) / 2, y: PAGE.height - PAGE.margin - 16 - h, width: w, height: h });
      piece.item.mergedPages = 1;
    } else if (piece.text !== undefined) {
      const tmp = await PDFDocument.create();
      const tw = new Writer(tmp, await loadFonts(tmp), `${brand} · ${piece.item.name}`);
      renderMarkdown(tw, piece.item.contentType === "text/markdown" ? piece.text : piece.text.split("\n").map((l) => (l.trim() ? l : "")).join("\n\n"));
      const copied = await out.copyPages(tmp, tmp.getPageIndices());
      for (const p of copied) out.addPage(p);
      piece.item.mergedPages = copied.length;
    } else {
      const page = out.addPage([PAGE.width, PAGE.height]);
      page.drawText(safeText(piece.item.name), { x: PAGE.margin, y: PAGE.height - PAGE.margin - 20, size: 16, font: fonts.body, color: INK });
      for (const [i, line] of wrap(safeText(piece.item.note ?? ""), fonts.body, 11.5, PAGE.width - PAGE.margin * 2).entries()) page.drawText(line, { x: PAGE.margin, y: PAGE.height - PAGE.margin - 50 - i * 16, size: 11.5, font: fonts.body, color: MUTED });
      piece.item.mergedPages = 1;
    }
    pageNo += piece.item.mergedPages ?? 0;
  }
  const total = out.getPageCount();

  // The cover: title, subtitle, contents with page numbers.
  const coverEntries: Array<{ label: string; detail: string; page: number; generated?: boolean }> = [
    { label: "1  Summary", detail: "prepared by the Helixona Assistant", page: summaryStart, generated: true },
    ...pieces.map((p, i) => ({ label: `${i + 2}  ${p.item.name}`, detail: p.item.source === "project" ? "project file" : "", page: p.item.startPage! })),
  ];
  for (let ci = 0; ci < coverPages; ci++) {
    const page = out.getPage(ci);
    page.drawRectangle({ x: 0, y: PAGE.height - 5, width: PAGE.width, height: 5, color: GOLD });
    page.drawText(brand, { x: PAGE.margin, y: PAGE.height - PAGE.margin + 4, size: 8.5, font: fonts.sans, color: rgb(0.54, 0.45, 0.28) });
    let y = PAGE.height - PAGE.margin - 40;
    if (ci === 0) {
      for (const line of wrap(safeText(input.title), fonts.body, 26, PAGE.width - PAGE.margin * 2)) {
        page.drawText(line, { x: PAGE.margin, y: y - 26, size: 26, font: fonts.body, color: INK });
        y -= 34;
      }
      for (const line of wrap(safeText(input.subtitle), fonts.body, 11, PAGE.width - PAGE.margin * 2)) {
        page.drawText(line, { x: PAGE.margin, y: y - 11, size: 11, font: fonts.body, color: MUTED });
        y -= 16;
      }
      y -= 22;
    }
    page.drawText(ci === 0 ? "CONTENTS" : "CONTENTS (CONTINUED)", { x: PAGE.margin, y: y - 9, size: 9.5, font: fonts.sans, color: rgb(0.54, 0.45, 0.28) });
    y -= 16;
    page.drawLine({ start: { x: PAGE.margin, y }, end: { x: PAGE.width - PAGE.margin, y }, thickness: 0.6, color: RULE });
    y -= 6;
    const rows = coverEntries.slice(ci * 30, ci * 30 + 30);
    const first = ci === 0 ? [{ label: "Cover and index", detail: "", page: 1 }, ...rows] : rows;
    for (const e of first) {
      const font = e.generated ? fonts.italic : fonts.body;
      const color = e.generated ? rgb(0.54, 0.45, 0.28) : INK;
      const pageText = String(e.page);
      const pageW = fonts.body.widthOfTextAtSize(pageText, 11);
      const labelW = PAGE.width - PAGE.margin * 2 - pageW - 14 - (e.detail ? fonts.italic.widthOfTextAtSize(safeText(e.detail), 9) + 8 : 0);
      const label = wrap(safeText(e.label), font, 11, labelW)[0] ?? "";
      page.drawText(label, { x: PAGE.margin, y: y - 11, size: 11, font, color });
      if (e.detail) page.drawText(safeText(e.detail), { x: PAGE.margin + font.widthOfTextAtSize(label, 11) + 8, y: y - 11, size: 9, font: fonts.italic, color: MUTED });
      page.drawText(pageText, { x: PAGE.width - PAGE.margin - pageW, y: y - 11, size: 11, font: fonts.body, color: MUTED });
      y -= 19;
      page.drawLine({ start: { x: PAGE.margin, y: y + 4 }, end: { x: PAGE.width - PAGE.margin, y: y + 4 }, thickness: 0.3, color: rgb(0.92, 0.92, 0.92) });
    }
    const note = pieces.length > 0 ? `Documents 2 to ${pieces.length + 1} are the originals, unchanged. The summary cites them by document and page.` : "This package holds the summary only.";
    page.drawText(safeText(note), { x: PAGE.margin, y: PAGE.margin - 6, size: 9, font: fonts.sans, color: MUTED });
  }
  // Page numbers on the pages the assistant made (cover and summary); the originals stay as they are.
  for (let i = 0; i < coverPages + summaryPages; i++) {
    const page = out.getPage(i);
    const label = `${i + 1} / ${total}`;
    page.drawText(label, { x: PAGE.width - PAGE.margin - fonts.sans.widthOfTextAtSize(label, 9), y: PAGE.margin - 6, size: 9, font: fonts.sans, color: MUTED });
  }
  const bytes = Buffer.from(await out.save());

  const includedIds = new Set(chosen.map((c) => c.id));
  const items: PackageItem[] = [
    { id: "summary", name: `${input.title} (summary)`, source: "summary", contentType: "application/pdf", pages: summaryPages, included: true, startPage: summaryStart, mergedPages: summaryPages },
    ...pieces.map((p) => p.item),
    ...input.candidates.filter((c) => !includedIds.has(c.id)).map((c) => ({ id: c.id, name: c.name, source: c.source, contentType: c.contentType, pages: c.pages, included: false, startPage: null, mergedPages: null })),
  ];
  const manifest: PackageManifest = { id: input.packageId, title: input.title, createdAt: input.createdAt ?? now, updatedAt: now, summary: input.summary, items, pages: total, bytes: bytes.length, candidates: input.candidates };
  await input.store.put(packageKey(input.conversationId, input.packageId, "package.pdf"), bytes, "application/pdf");
  await input.store.put(packageKey(input.conversationId, input.packageId, "summary.pdf"), summaryBytes, "application/pdf");
  await input.store.put(packageKey(input.conversationId, input.packageId, "manifest.json"), Buffer.from(JSON.stringify(manifest), "utf8"), "application/json");
  return manifest;
}

export async function loadManifest(store: AttachmentStore, conversationId: string, packageId: string): Promise<PackageManifest | null> {
  try {
    return JSON.parse((await store.get(packageKey(conversationId, packageId, "manifest.json"))).toString("utf8")) as PackageManifest;
  } catch {
    return null;
  }
}

/** The package as separate files: the summary (PDF and Markdown) and the originals, untouched. */
export async function packageZip(store: AttachmentStore, conversationId: string, manifest: PackageManifest, candidates: Map<string, AttachmentMeta>): Promise<Buffer> {
  const zip = new JSZip();
  const folder = zip.folder(safeName(manifest.title))!;
  const width = String(manifest.items.filter((i) => i.included).length).length;
  const num = (n: number) => String(n).padStart(Math.max(2, width), "0");
  folder.file(`${num(1)} ${safeName(manifest.title)} - summary.pdf`, await store.get(packageKey(conversationId, manifest.id, "summary.pdf")));
  folder.file(`${num(1)} ${safeName(manifest.title)} - summary.md`, manifest.summary);
  const lines = [`${manifest.title}`, "", `Prepared with the Helixona Assistant on ${manifest.updatedAt.slice(0, 10)}.`, "", "Contents:", `${num(1)}  Summary`];
  let n = 2;
  for (const item of manifest.items.filter((i) => i.included && i.source !== "summary")) {
    const meta = candidates.get(item.id);
    if (meta) {
      try {
        folder.file(`${num(n)} ${safeName(item.name)}`, await store.get(meta.key));
        lines.push(`${num(n)}  ${item.name}${item.source === "project" ? " (project file)" : ""}`);
      } catch {
        lines.push(`${num(n)}  ${item.name} (no longer available)`);
      }
    } else lines.push(`${num(n)}  ${item.name} (no longer available)`);
    n++;
  }
  folder.file("00 Index.txt", lines.join("\n"));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

// ---------------------------------------------------------------- The tool

export interface PackageToolsOptions {
  store: AttachmentStore;
  log: SafeLogger;
  conversationId: string;
  /** The conversation's title: named on the cover. */
  conversationTitle: string;
  candidates: PackageCandidate[];
  /** Called when a package is built, so the interface can show it at once. */
  onPackage: (manifest: PublicPackage) => void;
  now?: () => Date;
}

const BuildInputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().min(1).max(200_000),
  documents: z.array(z.string().trim().min(1).max(200)).max(MAX_DOCUMENTS).default([]),
});

export class PackageTools {
  constructor(private readonly opts: PackageToolsOptions) {}

  get definitions(): BetaToolUnion[] {
    const list = this.opts.candidates.map((c) => `- "${c.name}"${c.source === "project" ? " (project file" : " (attached to this conversation"}${c.pages ? `, ${c.pages} pages` : ""})`).join("\n");
    const tool: BetaTool = {
      name: "build_package",
      description:
        `Builds a package for the person to download: one PDF that opens with a cover and an index, then your summary, then the chosen documents appended whole and unchanged (a ZIP with the same pieces as separate files is offered too). Use it when the person asks for a package, a bundle, a binder, a submission or "the summary with the documents". Write the complete summary in Markdown in \`summary\`: start with a level-1 heading that is its title, then level-2 sections, lists and short tables; cite the documents by number and page as they will appear in the package ("doc. 3, p. 2"), where document 1 is the summary and the chosen documents follow in the order you give them. Choose the documents the person asked for, by their exact names from this list (an empty list makes a summary-only package):\n${list || "- (no document in this conversation can be packaged: only PDFs, images and text files can)"}\nThe interface shows the package as a card with Download PDF and Download ZIP; the person can add or remove documents there. Do not repeat the summary in your answer: say in one or two lines what the package holds and what to review.`,
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "The package's name, also the file name (for example: Appeal package – Aetna denial)" },
          summary: { type: "string", description: "The summary, complete, in Markdown, starting with a level-1 heading" },
          documents: { type: "array", items: { type: "string" }, description: "Exact names of the documents to append, in order" },
        },
        required: ["title", "summary"],
      },
    };
    return [tool];
  }

  describe(call: ToolCall): string {
    const input = (call.input ?? {}) as Record<string, unknown>;
    const n = Array.isArray(input.documents) ? input.documents.length : 0;
    return `Building the package${typeof input.title === "string" && input.title ? ` "${input.title}"` : ""}: the summary and ${n === 1 ? "1 document" : `${n} documents`}`;
  }

  async execute(call: ToolCall, _signal: AbortSignal, _ctx?: ToolContext): Promise<ToolOutput> {
    if (call.name !== "build_package") return { content: [{ type: "text", text: `Unknown tool "${call.name}".` }], isError: true, summary: `Unknown tool ${call.name}` };
    const parsed = BuildInputSchema.safeParse(call.input);
    if (!parsed.success) return { content: [{ type: "text", text: `Invalid input for build_package: ${parsed.error.issues[0]?.message ?? "invalid"}` }], isError: true, summary: `${this.describe(call)}: invalid input` };
    const { title, summary, documents } = parsed.data;
    const selection: string[] = [];
    const missing: string[] = [];
    for (const name of documents) {
      const found = [...this.opts.candidates].reverse().find((c) => c.name === name) ?? [...this.opts.candidates].reverse().find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (found && !selection.includes(found.id)) selection.push(found.id);
      else if (!found) missing.push(name);
    }
    const now = this.opts.now ?? (() => new Date());
    const date = now().toISOString().slice(0, 10);
    const manifest = await buildPackage({
      store: this.opts.store,
      conversationId: this.opts.conversationId,
      packageId: ulid(),
      title,
      summary,
      candidates: this.opts.candidates,
      selection,
      subtitle: `${this.opts.conversationTitle} · prepared ${date} with the Helixona Assistant`,
      now,
    });
    this.opts.onPackage(publicManifest(manifest));
    const included = manifest.items.filter((i) => i.included);
    const contents = included.map((i, n) => `${n + 1}. ${i.name}${i.startPage ? ` (p. ${i.startPage})` : ""}${i.note ? ` — ${i.note}` : ""}`).join("\n");
    const docs = included.length - 1;
    const text = `Package built: "${title}", ${docs === 1 ? "1 document" : `${docs} documents`} after the summary, ${manifest.pages} pages. The person sees a card with Download PDF and Download ZIP and can change the contents.\nContents:\n${contents}${missing.length > 0 ? `\nNot found (not included): ${missing.map((m) => `"${m}"`).join(", ")}` : ""}`;
    this.opts.log.info("package_built", { conversationId: this.opts.conversationId, documents: docs, pages: manifest.pages, bytes: manifest.bytes });
    return { content: [{ type: "text", text }], summary: `Built the package "${title}": the summary and ${docs === 1 ? "1 document" : `${docs} documents`}, ${manifest.pages} pages` };
  }
}
