import { useContext, useState } from "react";
import {
  DOC_FORMAT_LABEL,
  copyFormatted,
  documentTitle,
  downloadBlob,
  markdownToClipboardHtml,
  markdownToCsv,
  markdownToDocxBlob,
  markdownToPlain,
  printMarkdownDocument,
  safeFileName,
  type DocFormat,
} from "../lib/markdownExport";
import { DocumentViewerContext } from "../lib/documentViewer";

interface Props {
  /** The document's content (Markdown), as the model wrote it inside the fence. */
  markdown: string;
  /** The format the model chose from the request; the others are one click away. */
  format: DocFormat;
  /** The message has finished streaming: the document may be opened and downloaded. */
  ready: boolean;
  /** Name for a document without a title of its own (the conversation's title). */
  fallbackTitle: string;
}

const LABEL: Record<DocFormat, string> = { word: "Word", pdf: "PDF", txt: "Text", csv: "CSV" };
const FORMATS: DocFormat[] = ["word", "pdf", "txt", "csv"];

/**
 * A response delivered as a file, like a document card in Claude.ai: the title, what kind of file it
 * is, Copy and a download button for the requested format, the other formats underneath. Clicking
 * the card opens the document in the viewer beside the chat. Everything is built in the browser.
 */
export function DocumentCard({ markdown, format, ready, fallbackTitle }: Props) {
  const openViewer = useContext(DocumentViewerContext);
  const [busy, setBusy] = useState<DocFormat | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = documentTitle(markdown, fallbackTitle);
  const base = safeFileName(title);
  const hasTable = markdownToCsv(markdown) !== null;
  // A spreadsheet needs a table; without one the main button falls back to Word.
  const primary: DocFormat = format === "csv" && !hasTable ? "word" : format;
  const others = FORMATS.filter((f) => f !== primary && (f !== "csv" || hasTable));

  const deliver = async (f: DocFormat) => {
    setBusy(f);
    setError(null);
    try {
      if (f === "word") downloadBlob(await markdownToDocxBlob(markdown), `${base}.docx`);
      else if (f === "pdf") printMarkdownDocument(markdown, title);
      else if (f === "txt") downloadBlob(new Blob([markdownToPlain(markdown)], { type: "text/plain;charset=utf-8" }), `${base}.txt`);
      else {
        const csv = markdownToCsv(markdown);
        if (csv === null) throw new Error("no table");
        downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${base}.csv`);
      }
    } catch {
      setError(f === "csv" ? "This document has no table to put in a spreadsheet. Use Word or Text instead." : "The file could not be created. Use Copy and paste into Word instead.");
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    setError(null);
    const ok = await copyFormatted(markdownToClipboardHtml(markdown), markdownToPlain(markdown));
    if (!ok) {
      setError("Could not copy. Open the document, select the text and copy it instead.");
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const face = (
    <>
      <span className="doc-icon" aria-hidden="true">
        <svg width="22" height="26" viewBox="0 0 22 26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 1.5h10l6 6v17H3z" />
          <path d="M13 1.5v6h6M6.5 12h9M6.5 16h9M6.5 20h6" />
        </svg>
      </span>
      <span className="doc-card-text">
        <span className="doc-title" title={title}>
          {title}
        </span>
        <span className="doc-kind">{ready ? DOC_FORMAT_LABEL[primary] : "Writing the document…"}</span>
      </span>
    </>
  );

  return (
    <div className="doc-card" role="group" aria-label={`Document: ${title}`}>
      <div className="doc-card-main">
        {openViewer && ready ? (
          <button type="button" className="doc-card-open" onClick={() => openViewer({ markdown, format: primary, title })} aria-label={`Open ${title}`} title="Open the preview">
            {face}
          </button>
        ) : (
          <div className="doc-card-open static">{face}</div>
        )}
        <div className="doc-card-actions">
          <button type="button" className="btn btn-small" disabled={!ready} onClick={() => void copy()} aria-label={`Copy ${title}`} title="Copy with its formatting, for Word, eClinicalWorks or email">
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="btn btn-primary btn-small" disabled={!ready || busy !== null} onClick={() => void deliver(primary)} aria-label={`Download ${title} as ${LABEL[primary]}`}>
            {busy === primary ? "Preparing…" : primary === "pdf" ? "Save as PDF" : `Download ${LABEL[primary]}`}
          </button>
        </div>
      </div>
      <div className="doc-card-foot">
        <span className="muted small">
          Also as{" "}
          {others.map((f, i) => (
            <span key={f}>
              {i > 0 ? " · " : ""}
              <button type="button" className="link small" disabled={!ready || busy !== null} onClick={() => void deliver(f)} aria-label={`Download ${title} as ${LABEL[f]}`}>
                {LABEL[f]}
              </button>
            </span>
          ))}
        </span>
        {openViewer && ready && (
          <button type="button" className="link small" onClick={() => openViewer({ markdown, format: primary, title })}>
            Open
          </button>
        )}
      </div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
