import { useEffect, useRef, useState } from "react";
import type { CatalogModel } from "../lib/types";
import { ApiError } from "../lib/api";
import { Icon } from "./Icon";

interface Props {
  models: CatalogModel[];
  defaultAlias: string;
  /** Starts a conversation with its first message; resolves once it exists. */
  onStart: (text: string, alias: string) => Promise<void>;
  placeholder?: string;
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/**
 * The box that starts a conversation, like Claude.ai's: on the home screen and at the top of a
 * project. The first message creates the conversation with the chosen model and sends it.
 */
export function StartComposer({ models, defaultAlias, onStart, placeholder = "How can I help you today?" }: Props) {
  const available = models.filter((m) => m.available);
  const [text, setText] = useState("");
  const [alias, setAlias] = useState(() => (available.some((m) => m.alias === defaultAlias) ? defaultAlias : (available[0]?.alias ?? defaultAlias)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const trimmed = text.trim();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const submit = async () => {
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(trimmed, alias);
      setText("");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="composer composer-start"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="start-message" className="visually-hidden">
        Message
      </label>
      <textarea
        id="start-message"
        ref={ref}
        rows={2}
        placeholder={placeholder}
        title="Enter to send, Shift+Enter for a new line"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        disabled={busy}
      />
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <div className="composer-bar">
        <div className="composer-left">
          <label htmlFor="start-model" className="visually-hidden">
            Model
          </label>
          <select id="start-model" className="model-switch" value={alias} onChange={(e) => setAlias(e.target.value)} disabled={busy} title="Model for the new conversation">
            {available.map((m) => (
              <option key={m.alias} value={m.alias}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="composer-right">
          <button type="submit" className="composer-send" disabled={busy || !trimmed} aria-label={busy ? "Starting…" : "Send"} title="Send (Enter)">
            <Icon name="arrow-up" />
          </button>
        </div>
      </div>
    </form>
  );
}
