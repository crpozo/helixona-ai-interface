import { memo, useEffect, useState } from "react";
import type { ChatMessage, Notice, Step } from "../lib/chatReducer";
import type { CatalogModel } from "../lib/types";
import { modelLabel } from "../lib/models";
import { Markdown } from "./Markdown";
import { FilesProgress } from "./FilesProgress";
import { formatSize, isZipType } from "../lib/files";
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

/** "0.4 s", "12 s", "1:05": how long a step took or has been running. */
function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return clock(Math.round(ms / 1000));
}

function stepText(s: Step, models: CatalogModel[]): string {
  return s.text.replace("{model}", s.model ? modelLabel(models, s.model) : "the model");
}

/**
 * What was done for this answer, step by step, like the activity list in Claude: open while the
 * answer is pending, with the running step and its clock in the summary line; collapsed to one
 * line with the total once the text arrives.
 */
function Steps({ steps, models, live }: { steps: Step[]; models: CatalogModel[]; live: boolean }) {
  const running = [...steps].reverse().find((s) => s.state === "running") ?? null;
  const elapsedS = useElapsed(running?.startedAt ?? null);
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  const total = steps.reduce((n, s) => n + (s.ms ?? 0), 0) + (running ? elapsedS * 1000 : 0);
  // Between two steps (the files are read, the request is about to go out) the answer is still pending.
  const summary = running ? `${stepText(running, models)}… ${clock(elapsedS)}` : live ? "Thinking…" : `${steps.length === 1 ? "1 step" : `${steps.length} steps`} · ${duration(total)}`;
  return (
    <details className="steps" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className={running || live ? "dot" : "step-dot"} aria-hidden="true" /> {summary}
      </summary>
      <ol className="step-list">
        {steps.map((s) => (
          <li key={s.id} className={`step ${s.state}`}>
            <span className="step-text">{stepText(s, models)}</span>
            <span className="step-time">{s.state === "done" ? duration(s.ms ?? 0) : clock(elapsedS)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Seconds since `since`, ticking once a second while shown. */
function useElapsed(since: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
/** A request this large (a big file, a long conversation) takes minutes to read before the answer starts. */
const LARGE_INPUT_TOKENS = 100_000;

/**
 * What is happening while the answer is pending: sending a large request, waiting for the model,
 * or the model thinking; with the time elapsed, so a long wait is not a frozen screen.
 */
function WaitIndicator({ wait, model, models }: { wait: ChatMessage["wait"]; model: string | null; models: CatalogModel[] }) {
  const elapsed = useElapsed(wait?.since ?? null);
  const name = model ? modelLabel(models, model) : "the model";
  const big = (wait?.inputTokens ?? 0) >= LARGE_INPUT_TOKENS;
  const time = elapsed >= 5 ? ` ${clock(elapsed)}` : "";
  const text = wait?.stage === "waiting" ? (big ? `Sending about ${Math.round(wait.inputTokens! / 1000).toLocaleString("en-US")}k tokens to ${name}…${time}` : `Waiting for ${name}…${time}`) : `Thinking…${time}`;
  return (
    <>
      <p className="thinking-indicator" role="status" aria-live="polite">
        <span className="dot" aria-hidden="true" /> {text}
      </p>
      {big && (
        <p className="wait-note muted small">
          {wait?.stage === "waiting"
            ? "A large file or a long conversation takes a few minutes to read before the answer starts."
            : "A large file takes longer to reason about. For lists, totals or per-patient figures, asking for a spreadsheet is fastest: the interface computes it from the file."}
        </p>
      )}
    </>
  );
}

function errorText(code: string, fallback: string): string {
  switch (code) {
    case "quota_exceeded":
      return "You have reached your daily quota. You can use the assistant again tomorrow.";
    case "context_limit":
      // The server says what is too long (the files, or the conversation) and what to do.
      return fallback || "This conversation is too long. Start a new conversation to continue.";
    case "model_unavailable":
      return "The model is currently unavailable.";
    case "network":
      return "Connection to the server was lost.";
    default:
      return fallback || "An error occurred while generating the response.";
  }
}

/** A message with many files (chart prep brings ten or more) shows the first few and a button for the rest. */
const FILES_COLLAPSE_OVER = 6;
const FILES_SHOWN_COLLAPSED = 4;

// Memoized: while one message streams, the others must not re-render on every token.
export const MessageBubble = memo(function MessageBubble({ message: m, models, onRetry, showAuthor = false, exportTitle = "" }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [allFiles, setAllFiles] = useState(false);
  const isUser = m.role === "user";
  const collapsibleFiles = m.attachments.length > FILES_COLLAPSE_OVER;
  const shownFiles = collapsibleFiles && !allFiles ? m.attachments.slice(0, FILES_SHOWN_COLLAPSED) : m.attachments;
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
  // While large files are checked or read, their progress takes the place of "Thinking…".
  const readingFiles = !!m.files && m.files.phase !== "read";
  const thinkingWhileWaiting = m.status === "pending" && !readingFiles;
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

      {!isUser && m.steps.length > 0 && <Steps steps={m.steps} models={models} live={m.status === "pending"} />}

      {!isUser && m.files && <FilesProgress files={m.files} active={m.status === "pending" || m.status === "streaming"} />}

      {!isUser && m.thinking && (
        <details className="thinking" open={showThinking} onToggle={(e) => setShowThinking((e.target as HTMLDetailsElement).open)}>
          <summary>Reasoning</summary>
          <pre className="thinking-body">{m.thinking}</pre>
        </details>
      )}

      {m.attachments.length > 0 && (
        <ul className="attach-list" aria-label={`Attached files (${m.attachments.length})`}>
          {shownFiles.map((a) => (
            <li key={a.id} className="attach-chip" title={a.zip ? `${a.name}: ${a.zip.files} files, ${a.zip.readable} the assistant can read` : a.name}>
              <span className="attach-icon" aria-hidden="true">{isZipType(a.contentType) ? "🗂️" : "📄"}</span>
              <span className="attach-name">{a.name}</span>
              <span className="attach-meta">
                {a.zip ? `${a.zip.files.toLocaleString("en-US")} ${a.zip.files === 1 ? "file" : "files"} · ` : a.pages ? `${a.pages} p · ` : ""}
                {formatSize(a.size)}
              </span>
            </li>
          ))}
          {collapsibleFiles && (
            <li>
              <button type="button" className="attach-more" aria-expanded={allFiles} onClick={() => setAllFiles((v) => !v)}>
                {allFiles ? "Show fewer" : `+${m.attachments.length - FILES_SHOWN_COLLAPSED} more files`}
              </button>
            </li>
          )}
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
          m.steps.length > 0 ? null : <WaitIndicator wait={m.wait} model={m.model} models={models} />
        ) : m.text ? (
          <Markdown text={m.text} documentReady={finished} fallbackTitle={exportTitle} />
        ) : null}
      </div>

      {!isUser && (m.notices.length > 0 || m.error) && (
        <footer className="msg-foot">
          {m.stopReason === "max_tokens" && !m.text && m.status !== "pending" && m.status !== "streaming" && (
            <p className="notice small" role="status">
              The answer ran out of room before any text was written: the model spent it all reasoning over the data. Ask for a narrower result (one patient, one payer, fewer columns), or ask for a spreadsheet, which the interface computes from the file.
            </p>
          )}
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
