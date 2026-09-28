import { useContext, useEffect, useState } from "react";
import { DOC_FORMAT_LABEL, copyFormatted, documentTitle, markdownToClipboardHtml, markdownToPlain, type DocFormat } from "../lib/markdownExport";
import { AttachmentFilesContext, DocumentViewerContext } from "../lib/documentViewer";
import { deliverDocument, FORMAT_LABEL, FORMATS, needsTable, NoTableError } from "../lib/deliver";
import { expandFileRefs, hasFileRefs, hasTables } from "../lib/workbook";

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

interface Resolved {
  source: string;
  markdown: string;
  problems: string[];
}

/**
 * The document with the rows of attached spreadsheets filled in where the model referenced them
 * ({{file: …}}), read from the files themselves; `loading` while they are fetched.
 */
function useResolvedMarkdown(markdown: string, ready: boolean): { markdown: string; problems: string[]; loading: boolean } {
  const resolve = useContext(AttachmentFilesContext);
  const needed = ready && resolve !== null && hasFileRefs(markdown);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  useEffect(() => {
    if (!needed || !resolve) return;
    let alive = true;
    void expandFileRefs(markdown, resolve).then((r) => {
      if (alive) setResolved({ source: markdown, ...r });
    });
    return () => {
      alive = false;
    };
  }, [needed, markdown, resolve]);
  if (!needed) return { markdown, problems: [], loading: false };
  if (resolved && resolved.source === markdown) return { markdown: resolved.markdown, problems: resolved.problems, loading: false };
  return { markdown, problems: [], loading: true };
}

/**
 * A response delivered as a file, like a document card in Claude.ai: the title, what kind of file it
 * is, Copy and a download button for the requested format, the other formats underneath. Clicking
 * the card opens the document in the viewer beside the chat. Everything is built in the browser.
 */
export function DocumentCard({ markdown: written, format, ready, fallbackTitle }: Props) {
  const openViewer = useContext(DocumentViewerContext);
  const { markdown, problems, loading } = useResolvedMarkdown(written, ready);
  const [busy, setBusy] = useState<DocFormat | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = documentTitle(markdown, fallbackTitle);
  const hasTable = hasTables(markdown);
  // A spreadsheet needs a table; without one the main button falls back to Word.
  const primary: DocFormat = needsTable(format) && !hasTable && !loading ? "word" : format;
  const others = FORMATS.filter((f) => f !== primary && (!needsTable(f) || hasTable));
  const usable = ready && !loading;

  const deliver = async (f: DocFormat) => {
    setBusy(f);
    setError(null);
    try {
      await deliverDocument(markdown, f, title);
    } catch (e) {
      setError(e instanceof NoTableError ? "This document has no table to put in a spreadsheet. Use Word or Text instead." : "The file could not be created. Use Copy and paste into Word instead.");
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

  const kind = !ready ? "Writing the document…" : loading ? "Copying the rows from the attached file…" : DOC_FORMAT_LABEL[primary];
  const face = (
    <>
      <span className="doc-icon" aria-hidden="true">
        {primary === "xlsx" || primary === "csv" ? (
          <svg width="22" height="26" viewBox="0 0 22 26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 1.5h10l6 6v17H3z" />
            <path d="M13 1.5v6h6M6 12h10v9H6zM6 15h10M6 18h10M10 12v9" />
          </svg>
        ) : (
          <svg width="22" height="26" viewBox="0 0 22 26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 1.5h10l6 6v17H3z" />
            <path d="M13 1.5v6h6M6.5 12h9M6.5 16h9M6.5 20h6" />
          </svg>
        )}
      </span>
      <span className="doc-card-text">
        <span className="doc-title" title={title}>
          {title}
        </span>
        <span className="doc-kind">{kind}</span>
      </span>
    </>
  );

  return (
    <div className="doc-card" role="group" aria-label={`Document: ${title}`}>
      <div className="doc-card-main">
        {openViewer && usable ? (
          <button type="button" className="doc-card-open" onClick={() => openViewer({ markdown, format: primary, title })} aria-label={`Open ${title}`} title="Open the preview">
            {face}
          </button>
        ) : (
          <div className="doc-card-open static">{face}</div>
        )}
        <div className="doc-card-actions">
          <button type="button" className="btn btn-small" disabled={!usable} onClick={() => void copy()} aria-label={`Copy ${title}`} title="Copy with its formatting, for Word, eClinicalWorks or email">
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="btn btn-primary btn-small" disabled={!usable || busy !== null} onClick={() => void deliver(primary)} aria-label={`Download ${title} as ${FORMAT_LABEL[primary]}`}>
            {busy === primary ? "Preparing…" : primary === "pdf" ? "Save as PDF" : `Download ${FORMAT_LABEL[primary]}`}
          </button>
        </div>
      </div>
      <div className="doc-card-foot">
        <span className="muted small">
          Also as{" "}
          {others.map((f, i) => (
            <span key={f}>
              {i > 0 ? " · " : ""}
              <button type="button" className="link small" disabled={!usable || busy !== null} onClick={() => void deliver(f)} aria-label={`Download ${title} as ${FORMAT_LABEL[f]}`}>
                {FORMAT_LABEL[f]}
              </button>
            </span>
          ))}
        </span>
        {openViewer && usable && (
          <button type="button" className="link small" onClick={() => openViewer({ markdown, format: primary, title })}>
            Open
          </button>
        )}
      </div>
      {problems.length > 0 && (
        <p className="notice notice-error" role="alert">
          {problems.join(" ")}
        </p>
      )}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
