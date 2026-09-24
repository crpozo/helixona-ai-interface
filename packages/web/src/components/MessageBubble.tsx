import { memo, useState } from "react";
import type { ChatMessage, Notice } from "../lib/chatReducer";
import type { CatalogModel } from "../lib/types";
import { modelLabel } from "../lib/models";
import { Markdown } from "./Markdown";
import { formatSize } from "../lib/files";
import { copyFormatted, docxFileName, downloadBlob, markdownToClipboardHtml, markdownToDocxBlob, markdownToPlain } from "../lib/markdownExport";

interface Props {
  message: ChatMessage;
  models: CatalogModel[];
  onRetry?: (message: ChatMessage) => void;
  /** Shared project: name the person who wrote each user turn. */
  showAuthor?: boolean;
  /** The conversation's title: the name of the Word file a response is downloaded as. */
  exportTitle?: string;
}

function noticeText(n: Notice, models: CatalogModel[]): string {
  switch (n.kind) {
    case "fallback":
      return `Continued by ${modelLabel(models, n.model)}`;
    case "model_switched":
      return `Answered by ${modelLabel(models, n.model)}`;
    case "truncated":
      return "Response truncated due to length";
    case "stopped":
      return "Stopped by you";
  }
}

function errorText(code: string, fallback: string): string {
  switch (code) {
    case "quota_exceeded":
      return "You have reached your daily quota. You can use the assistant again tomorrow.";
    case "context_limit":
      return "This conversation is too long. Start a new conversation to continue.";
    case "model_unavailable":
      return "The model is currently unavailable.";
    case "network":
      return "Connection to the server was lost.";
    default:
      return fallback || "An error occurred while generating the response.";
  }
}

// Memoized: while one message streams, the others must not re-render on every token.
export const MessageBubble = memo(function MessageBubble({ message: m, models, onRetry, showAuthor = false, exportTitle = "" }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const isUser = m.role === "user";
  // Copy with formatting (Word, eClinicalWorks, email keep headings, bold, lists and tables) or download as Word.
  const finished = m.status === "done" || m.status === "incomplete";
  // A response delivered as a document has its own card with Copy and the downloads.
  const hasDocument = /^```document(?:-\w+)?\s*$/m.test(m.text);
  const canExport = !isUser && !!m.text && finished && !hasDocument;
  const copy = async () => {
    setExportError(null);
    const ok = await copyFormatted(markdownToClipboardHtml(m.text), markdownToPlain(m.text));
    if (!ok) {
      setExportError("Could not copy. Select the text and copy it instead.");
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };
  const download = async () => {
    setExporting(true);
    setExportError(null);
    try {
      downloadBlob(await markdownToDocxBlob(m.text), docxFileName(exportTitle));
    } catch {
      setExportError("The Word file could not be created. Use Copy and paste into Word instead.");
    } finally {
      setExporting(false);
    }
  };
  const thinkingWhileWaiting = m.status === "pending";
  const canRetry =
    !!onRetry &&
    m.retryText !== null &&
    (m.status === "error" || m.status === "incomplete") &&
    m.error?.code !== "quota_exceeded" &&
    m.error?.code !== "context_limit";

  return (
    <article className={`msg ${isUser ? "msg-user" : "msg-assistant"}`} aria-label={isUser ? "Your message" : "Assistant response"}>
      {isUser && showAuthor && m.authorName && (
        <header className="msg-head">
          <span className="msg-author">{m.authorName}</span>
        </header>
      )}

      {!isUser && m.model && (
        <header className="msg-head">
          <span className="badge badge-model" title={m.model}>
            {modelLabel(models, m.model)}
          </span>
        </header>
      )}

      {!isUser && m.thinking && (
        <details className="thinking" open={showThinking} onToggle={(e) => setShowThinking((e.target as HTMLDetailsElement).open)}>
          <summary>Reasoning</summary>
          <pre className="thinking-body">{m.thinking}</pre>
        </details>
      )}

      {m.attachments.length > 0 && (
        <ul className="attach-list" aria-label="Attached files">
          {m.attachments.map((a) => (
            <li key={a.id} className="attach-chip" title={a.name}>
              <span className="attach-icon" aria-hidden="true">📄</span>
              <span className="attach-name">{a.name}</span>
              <span className="attach-meta">
                {a.pages ? `${a.pages} p · ` : ""}
                {formatSize(a.size)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="msg-body">
        {isUser ? (
          <p className="user-text">{m.text}</p>
        ) : m.status === "refused" ? (
          <p className="refused" role="status">
            The assistant can't help with this request
            {m.refusalCategory ? ` (${m.refusalCategory})` : ""}.
          </p>
        ) : thinkingWhileWaiting ? (
          <p className="thinking-indicator" role="status" aria-live="polite">
            <span className="dot" aria-hidden="true" /> Thinking…
          </p>
        ) : m.text ? (
          <Markdown text={m.text} documentReady={finished} fallbackTitle={exportTitle} />
        ) : null}
      </div>

      {!isUser && (m.notices.length > 0 || m.error) && (
        <footer className="msg-foot">
          {m.notices.map((n, i) => (
            <span key={i} className="notice">
              {noticeText(n, models)}
            </span>
          ))}
          {m.error && (
            <span className={`notice notice-error`} role="alert">
              {m.status === "incomplete" && m.error.code !== "network" ? "Incomplete response. " : ""}
              {errorText(m.error.code, m.error.message)}
            </span>
          )}
          {canRetry && (
            <button type="button" className="btn btn-small" onClick={() => onRetry?.(m)}>
              Retry
            </button>
          )}
        </footer>
      )}

      {canExport && (
        <div className="msg-actions">
          <button type="button" className="btn btn-small btn-quiet" onClick={() => void copy()} aria-label="Copy the response (formatted)" title="Copy with its formatting, for Word, eClinicalWorks or email">
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" className="btn btn-small btn-quiet" onClick={() => void download()} disabled={exporting} aria-label="Download the response as a Word document" title="Download as a Word document">
            {exporting ? "Preparing…" : "Download Word"}
          </button>
          {exportError && (
            <span className="notice notice-error" role="alert">
              {exportError}
            </span>
          )}
        </div>
      )}
    </article>
  );
});
