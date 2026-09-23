import { useEffect, useRef, useState } from "react";
import type { CatalogModel } from "../lib/types";
import { ApiError } from "../lib/api";
import { attachmentType, formatSize } from "../lib/files";
import { Icon } from "./Icon";

export interface StartAttachmentLimits {
  maxMb: number;
  maxPerMessage: number;
}

interface Props {
  models: CatalogModel[];
  defaultAlias: string;
  /** Upload limits when files may travel with the first message; null when uploads are off. */
  attachments?: StartAttachmentLimits | null;
  /** Starts a conversation with its first message and files; resolves once it exists. */
  onStart: (text: string, alias: string, files: File[]) => Promise<void>;
  placeholder?: string;
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : "Something went wrong. Please try again.";
}

/**
 * The box that starts a conversation, like Claude.ai's: on the home screen and at the top of a
 * project. The first message (and any files picked here) creates the conversation with the chosen
 * model and sends it.
 */
export function StartComposer({ models, defaultAlias, attachments = null, onStart, placeholder = "How can I help you today?" }: Props) {
  const available = models.filter((m) => m.available);
  const [text, setText] = useState("");
  const [alias, setAlias] = useState(() => (available.some((m) => m.alias === defaultAlias) ? defaultAlias : (available[0]?.alias ?? defaultAlias)));
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const trimmed = text.trim();
  const canSend = !busy && (trimmed.length > 0 || files.length > 0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const addFiles = (list: FileList | null) => {
    if (!list || !attachments) return;
    const room = Math.max(0, attachments.maxPerMessage - files.length);
    const picked = Array.from(list);
    const problems: string[] = [];
    const accepted: File[] = [];
    for (const file of picked.slice(0, room)) {
      const type = attachmentType(file);
      if (!type) {
        problems.push(`${file.name}: unsupported type. Use PDF, TXT, MD or CSV.`);
        continue;
      }
      const maxMb = type === "application/pdf" ? attachments.maxMb : Math.min(attachments.maxMb, 5);
      if (file.size > maxMb * 1048576) {
        problems.push(`${file.name}: too large (limit ${maxMb} MB).`);
        continue;
      }
      accepted.push(file);
    }
    if (picked.length > room) problems.push(`Up to ${attachments.maxPerMessage} files per message: ${picked.length - room} not added.`);
    setFiles((prev) => [...prev, ...accepted]);
    setError(problems.length ? problems.join(" ") : null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(trimmed, alias, files);
      setText("");
      setFiles([]);
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
      {files.length > 0 && (
        <ul className="attach-list composer-pending" aria-label="Files to send">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="attach-chip" title={f.name}>
              <span className="attach-icon" aria-hidden="true">📄</span>
              <span className="attach-name">{f.name}</span>
              <span className="attach-meta">{formatSize(f.size)}</span>
              <button type="button" className="attach-remove" onClick={() => setFiles((prev) => prev.filter((_, k) => k !== i))} aria-label={`Remove ${f.name}`} disabled={busy}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
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
        onPaste={(e) => {
          if (attachments && e.clipboardData.files.length > 0) {
            e.preventDefault();
            addFiles(e.clipboardData.files);
          }
        }}
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
          {attachments && (
            <>
              <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv" multiple hidden onChange={(e) => addFiles(e.target.files)} />
              <button
                type="button"
                className="icon-btn composer-attach"
                onClick={() => fileRef.current?.click()}
                disabled={busy || files.length >= attachments.maxPerMessage}
                aria-label="Attach file"
                title={`Attach a file: PDF, TXT, MD or CSV up to ${attachments.maxMb} MB, ${attachments.maxPerMessage} files per message`}
              >
                <Icon name="plus" />
              </button>
            </>
          )}
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
          <button type="submit" className="composer-send" disabled={!canSend} aria-label={busy ? (files.length ? "Uploading…" : "Starting…") : "Send"} title="Send (Enter)">
            <Icon name="arrow-up" />
          </button>
        </div>
      </div>
    </form>
  );
}
