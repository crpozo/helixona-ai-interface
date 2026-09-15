import { useState } from "react";
import type { ChatMessage, Notice } from "../lib/chatReducer";
import type { CatalogModel } from "../lib/types";
import { modelLabel } from "../lib/models";
import { Markdown } from "./Markdown";

interface Props {
  message: ChatMessage;
  models: CatalogModel[];
  onRetry?: (message: ChatMessage) => void;
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

export function MessageBubble({ message: m, models, onRetry }: Props) {
  const [showThinking, setShowThinking] = useState(false);
  const isUser = m.role === "user";
  const thinkingWhileWaiting = m.status === "pending";
  const canRetry =
    !!onRetry &&
    m.retryText !== null &&
    (m.status === "error" || m.status === "incomplete") &&
    m.error?.code !== "quota_exceeded" &&
    m.error?.code !== "context_limit";

  return (
    <article className={`msg ${isUser ? "msg-user" : "msg-assistant"}`} aria-label={isUser ? "Your message" : "Assistant response"}>
      <header className="msg-head">
        <span className="msg-role">{isUser ? "You" : "Assistant"}</span>
        {!isUser && m.model && (
          <span className="badge badge-model" title={m.model}>
            {modelLabel(models, m.model)}
          </span>
        )}
      </header>

      {!isUser && m.thinking && (
        <details className="thinking" open={showThinking} onToggle={(e) => setShowThinking((e.target as HTMLDetailsElement).open)}>
          <summary>Reasoning</summary>
          <pre className="thinking-body">{m.thinking}</pre>
        </details>
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
          <Markdown text={m.text} />
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
    </article>
  );
}
