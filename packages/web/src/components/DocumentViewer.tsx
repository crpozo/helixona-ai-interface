import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { downloadBlob, markdownToCsv, markdownToDocxBlob, markdownToHtml, markdownToPlain, printMarkdownDocument, safeFileName, type DocFormat } from "../lib/markdownExport";
import type { OpenDocument } from "../lib/documentViewer";
import { Icon } from "./Icon";

/** US Letter at 96 dpi with one-inch margins: the page the Word file and the print stylesheet use. */
export const PAGE_WIDTH = 816;
export const PAGE_HEIGHT = 1056;
export const PAGE_MARGIN = 96;
/** The letterhead line at the top of every page. */
const HEADER_HEIGHT = 56;
const PAGE_GAP = 24;
const KIND: Record<DocFormat, string> = { word: "DOCX", pdf: "PDF", txt: "TXT", csv: "CSV" };

interface Props {
  doc: OpenDocument;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
}

/** Cuts the document's blocks into pages by their rendered height (a block taller than a page stays whole). */
export function paginate(blocks: { html: string; height: number }[], capacity = PAGE_HEIGHT - 2 * PAGE_MARGIN - HEADER_HEIGHT): string[] {
  const pages: string[][] = [[]];
  let used = 0;
  for (const b of blocks) {
    if (used + b.height > capacity && pages[pages.length - 1]!.length > 0) {
      pages.push([]);
      used = 0;
    }
    pages[pages.length - 1]!.push(b.html);
    used += b.height;
  }
  return pages.map((p) => p.join(""));
}

/**
 * The document as it will print: white Letter pages with the letterhead line, laid out beside the
 * chat (or over it, on a phone), with a download for its format, expand and close, and a page
 * counter that follows the scroll. Blocks are measured on a hidden page of the real width and cut
 * into pages by height; the pages are then scaled to the panel.
 */
export function DocumentViewer({ doc, expanded, onToggleExpand, onClose }: Props) {
  const html = useMemo(() => markdownToHtml(doc.markdown), [doc.markdown]);
  const [pages, setPages] = useState<string[]>([html]);
  const [scale, setScale] = useState(1);
  const [page, setPage] = useState(1);
  const [sheetsHeight, setSheetsHeight] = useState(PAGE_HEIGHT);
  const [busy, setBusy] = useState(false);
  const measureRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const sheetsRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    el.innerHTML = html;
    const blocks = Array.from(el.children).map((child) => {
      const cs = getComputedStyle(child);
      const box = child as HTMLElement;
      return { html: box.outerHTML, height: box.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0) };
    });
    el.innerHTML = "";
    setPages(blocks.length > 0 ? paginate(blocks) : [html]);
    setPage(1);
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [html]);

  // The pages are scaled to the panel's width; the frame keeps the scaled height so the panel scrolls.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const fit = () => setScale(Math.max(0.2, Math.min(1, (body.clientWidth - 32) / PAGE_WIDTH)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(body);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const sheets = sheetsRef.current;
    if (!sheets || typeof ResizeObserver === "undefined") return;
    const measure = () => setSheetsHeight(sheets.offsetHeight || PAGE_HEIGHT);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sheets);
    return () => ro.disconnect();
  }, [pages]);

  const onScroll = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    const step = (PAGE_HEIGHT + PAGE_GAP) * scale;
    setPage(Math.max(1, Math.min(pages.length, Math.floor((body.scrollTop + body.clientHeight / 3) / step) + 1)));
  }, [pages.length, scale]);

  const download = async () => {
    setBusy(true);
    try {
      const base = safeFileName(doc.title);
      const csv = doc.format === "csv" ? markdownToCsv(doc.markdown) : null;
      if (doc.format === "pdf") printMarkdownDocument(doc.markdown, doc.title);
      else if (doc.format === "txt") downloadBlob(new Blob([markdownToPlain(doc.markdown)], { type: "text/plain;charset=utf-8" }), `${base}.txt`);
      else if (csv !== null) downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${base}.csv`);
      else downloadBlob(await markdownToDocxBlob(doc.markdown), `${base}.docx`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className={`doc-viewer${expanded ? " expanded" : ""}`} aria-label={`Preview of ${doc.title}`}>
      <header className="doc-viewer-head">
        <h2 className="doc-viewer-title" title={doc.title}>
          {doc.title} <span className="muted">· {KIND[doc.format]}</span>
        </h2>
        <div className="doc-viewer-actions">
          <button type="button" className="icon-btn" onClick={() => void download()} disabled={busy} aria-label={`Download ${doc.title}`} title={doc.format === "pdf" ? "Save as PDF" : "Download"}>
            <Icon name="download" />
          </button>
          <button type="button" className="icon-btn" onClick={onToggleExpand} aria-label={expanded ? "Shrink the preview" : "Expand the preview"} aria-pressed={expanded} title={expanded ? "Shrink" : "Expand"}>
            <Icon name={expanded ? "collapse" : "expand"} />
          </button>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close the preview" title="Close">
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className="doc-viewer-body" ref={bodyRef} onScroll={onScroll}>
        <div className="doc-sheets-frame" style={{ height: sheetsHeight * scale, width: PAGE_WIDTH * scale }}>
          <div className="doc-sheets" ref={sheetsRef} style={{ transform: `scale(${scale})` }}>
            {pages.map((p, i) => (
              <div key={i} className="doc-page doc-paper" data-page={i + 1}>
                <div className="print-doc-brand">HELIXONA</div>
                <div dangerouslySetInnerHTML={{ __html: p }} />
                <div className="doc-page-number" aria-hidden="true">
                  Page {i + 1}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="doc-paper doc-measure" ref={measureRef} aria-hidden="true" />
      </div>
      <div className="doc-page-pill" aria-live="polite">
        Page {page} / {pages.length}
      </div>
    </aside>
  );
}
