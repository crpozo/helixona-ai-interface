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
      return `Continuado por ${modelLabel(models, n.model)}`;
    case "model_switched":
      return `Respondido por ${modelLabel(models, n.model)}`;
    case "truncated":
      return "Respuesta truncada por longitud";
    case "stopped":
      return "Detenido por ti";
  }
}

function errorText(code: string, fallback: string): string {
  switch (code) {
    case "quota_exceeded":
      return "Has agotado tu cuota diaria. Podrás volver a usar el asistente mañana.";
    case "context_limit":
      return "Esta conversación es demasiado larga. Abre una nueva conversación para continuar.";
    case "model_unavailable":
      return "El modelo no está disponible en este momento.";
    case "network":
      return "Se perdió la conexión con el servidor.";
    default:
      return fallback || "Se produjo un error al generar la respuesta.";
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
    <article className={`msg ${isUser ? "msg-user" : "msg-assistant"}`} aria-label={isUser ? "Tu mensaje" : "Respuesta del asistente"}>
      <header className="msg-head">
        <span className="msg-role">{isUser ? "Tú" : "Asistente"}</span>
        {!isUser && m.model && (
          <span className="badge badge-model" title={m.model}>
            {modelLabel(models, m.model)}
          </span>
        )}
      </header>

      {!isUser && m.thinking && (
        <details className="thinking" open={showThinking} onToggle={(e) => setShowThinking((e.target as HTMLDetailsElement).open)}>
          <summary>Razonamiento</summary>
          <pre className="thinking-body">{m.thinking}</pre>
        </details>
      )}

      <div className="msg-body">
        {isUser ? (
          <p className="user-text">{m.text}</p>
        ) : m.status === "refused" ? (
          <p className="refused" role="status">
            El asistente no puede ayudar con esta solicitud
            {m.refusalCategory ? ` (${m.refusalCategory})` : ""}.
          </p>
        ) : thinkingWhileWaiting ? (
          <p className="thinking-indicator" role="status" aria-live="polite">
            <span className="dot" aria-hidden="true" /> Pensando…
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
              {m.status === "incomplete" && m.error.code !== "network" ? "Respuesta incompleta. " : ""}
              {errorText(m.error.code, m.error.message)}
            </span>
          )}
          {canRetry && (
            <button type="button" className="btn btn-small" onClick={() => onRetry?.(m)}>
              Reintentar
            </button>
          )}
        </footer>
      )}
    </article>
  );
}
