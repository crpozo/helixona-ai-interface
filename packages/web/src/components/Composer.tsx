import { useEffect, useRef, useState } from "react";
import type { AttachmentLimits, AttachmentMeta } from "../lib/types";
import { ApiError, createAttachment, uploadFile } from "../lib/api";
import { attachmentType, formatSize } from "../lib/files";

interface Props {
  conversationId: string;
  maxChars: number;
  /** Upload limits from /api/me; null when uploads are disabled on the server. */
  attachments: AttachmentLimits | null;
  streaming: boolean;
  disabled?: boolean;
  onSend: (text: string, attachments: AttachmentMeta[]) => void;
  onStop: () => void;
  /** Controls shown at the start of the bottom bar (the model picker lives here, like Claude.ai). */
  leading?: React.ReactNode;
}

interface Pending {
  localId: string;
  id: string | null;
  name: string;
  contentType: string;
  size: number;
  progress: number;
  status: "uploading" | "ready" | "error";
  error: string | null;
  abort: AbortController;
}

export function Composer({ conversationId, maxChars, attachments, streaming, disabled = false, onSend, onStop, leading }: Props) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const trimmed = text.trim();
  const over = text.length > maxChars;
  const uploading = pending.some((p) => p.status === "uploading");
  const failed = pending.some((p) => p.status === "error");
  const ready = pending.filter((p) => p.status === "ready");
  const canSend = !streaming && !disabled && !over && !uploading && !failed && (trimmed.length > 0 || ready.length > 0);
  const canAttach = !!attachments && !disabled && pending.length < (attachments?.maxPerMessage ?? 0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  // Files belong to one conversation: drop what was pending when the user switches.
  useEffect(() => {
    setPending((prev) => {
      prev.forEach((p) => p.abort.abort());
      return [];
    });
  }, [conversationId]);

  const update = (localId: string, patch: Partial<Pending>) =>
    setPending((prev) => prev.map((p) => (p.localId === localId ? { ...p, ...patch } : p)));

  const addFiles = (files: FileList | null) => {
    if (!files || !attachments) return;
    const room = Math.max(0, attachments.maxPerMessage - pending.length);
    for (const file of Array.from(files).slice(0, room)) {
      const localId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const abort = new AbortController();
      const contentType = attachmentType(file);
      const entry: Pending = { localId, id: null, name: file.name, contentType: contentType ?? "", size: file.size, progress: 0, status: "uploading", error: null, abort };
      if (!contentType) {
        setPending((prev) => [...prev, { ...entry, status: "error", error: "Unsupported type. Use PDF, TXT, MD or CSV." }]);
        continue;
      }
      const maxMb = contentType === "application/pdf" ? attachments.maxMb : Math.min(attachments.maxMb, 5);
      if (file.size > maxMb * 1048576) {
        setPending((prev) => [...prev, { ...entry, status: "error", error: `Too large (limit ${maxMb} MB per file).` }]);
        continue;
      }
      setPending((prev) => [...prev, entry]);
      void (async () => {
        try {
          const created = await createAttachment(conversationId, { name: file.name, size: file.size, contentType });
          update(localId, { id: created.id, name: created.name });
          await uploadFile(created.upload, file, (fraction) => update(localId, { progress: fraction }), abort.signal);
          update(localId, { status: "ready", progress: 1 });
        } catch (e) {
          if (abort.signal.aborted) return;
          update(localId, { status: "error", error: e instanceof ApiError ? e.message : "Upload failed. Please try again." });
        }
      })();
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const remove = (localId: string) =>
    setPending((prev) => {
      prev.find((p) => p.localId === localId)?.abort.abort();
      return prev.filter((p) => p.localId !== localId);
    });

  const submit = () => {
    if (!canSend) return;
    const metas: AttachmentMeta[] = ready.map((p) => ({ id: p.id!, name: p.name, contentType: p.contentType, size: p.size, pages: null }));
    onSend(trimmed, metas);
    setText("");
    setPending([]);
    ref.current?.focus();
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {pending.length > 0 && (
        <ul className="attach-list composer-pending" aria-label="Files to send">
          {pending.map((p) => (
            <li key={p.localId} className={`attach-chip${p.status === "error" ? " error" : ""}`} title={p.error ?? p.name}>
              <span className="attach-icon" aria-hidden="true">📄</span>
              <span className="attach-name">{p.name}</span>
              {p.status === "uploading" && (
                <span className="attach-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.progress * 100)} aria-label={`Uploading ${p.name}`}>
                  <span style={{ width: `${Math.round(p.progress * 100)}%` }} />
                </span>
              )}
              {p.status === "ready" && <span className="attach-meta">{formatSize(p.size)}</span>}
              {p.status === "error" && <span className="attach-meta">{p.error}</span>}
              <button type="button" className="attach-remove" onClick={() => remove(p.localId)} aria-label={`Remove ${p.name}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <label htmlFor="composer-text" className="visually-hidden">
        Message
      </label>
      <textarea
        id="composer-text"
        ref={ref}
        value={text}
        rows={1}
        placeholder={attachments ? "Type your message or attach a PDF… (Enter to send, Shift+Enter for a new line)" : "Type your message… (Enter to send, Shift+Enter for a new line)"}
        disabled={disabled}
        aria-invalid={over || undefined}
        aria-describedby="composer-counter"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-bar">
        <div className="row gap wrap">
          {leading}
          {attachments && (
            <>
              <input ref={fileRef} type="file" accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv" multiple hidden onChange={(e) => addFiles(e.target.files)} />
              <button type="button" className="btn btn-small" onClick={() => fileRef.current?.click()} disabled={!canAttach} title={`PDF up to ${attachments.maxMb} MB, ${attachments.maxPerMessage} files per message`}>
                Attach file
              </button>
            </>
          )}
          <span id="composer-counter" className={`counter${over ? " over" : ""}`} aria-live="polite">
            {text.length.toLocaleString("en-US")} / {maxChars.toLocaleString("en-US")}
          </span>
        </div>
        <div className="row gap">
          {streaming && (
            <button type="button" className="btn btn-danger" onClick={onStop}>
              Stop
            </button>
          )}
          <button type="submit" className="btn btn-primary" disabled={!canSend}>
            {uploading ? "Uploading…" : "Send"}
          </button>
        </div>
      </div>
    </form>
  );
}
