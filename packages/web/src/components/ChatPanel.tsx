import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatState } from "../lib/chatReducer";
import type { AttachmentMeta, Conversation, Me } from "../lib/types";
import { modelLabel } from "../lib/models";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";

interface Props {
  me: Me;
  conversation: Conversation;
  projectName: string | null;
  state: ChatState;
  loading: boolean;
  onSend: (text: string, attachments: AttachmentMeta[]) => void;
  onStop: () => void;
  onRetry: (message: ChatMessage) => void;
  onChangeModel: (alias: string) => void;
  onOpenProject?: () => void;
  /** The conversation belongs to a shared project: everyone in it sees it, so each message names its author. */
  shared?: boolean;
}

/** Distance from the bottom (px) under which the reader counts as "at the bottom". */
const FOLLOW_THRESHOLD = 48;

export function ChatPanel({ me, conversation, projectName, state, loading, onSend, onStop, onRetry, onChangeModel, onOpenProject, shared = false }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLElement>(null);
  // Follow mode keeps the newest text in view only while the reader is at the bottom. Scrolling up
  // during streaming switches it off (no forced jumps, no flicker); scrolling back down, sending a
  // message or opening another conversation switches it on again.
  const followRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const models = me.catalog.models;
  const available = models.filter((m) => m.available !== false);
  const last = state.messages[state.messages.length - 1];
  const count = state.messages.length;
  const lastText = last?.text.length ?? 0;
  const lastRole = last?.role ?? null;

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const follow = useCallback(() => {
    followRef.current = true;
    setAtBottom(true);
    scrollToBottom();
  }, [scrollToBottom]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD;
    followRef.current = near;
    setAtBottom((prev) => (prev === near ? prev : near));
  };

  // Another conversation, or its messages just loaded: start at the bottom.
  useEffect(() => {
    if (!loading) follow();
  }, [conversation.id, loading, follow]);
  // The reader's own message: always show it.
  useEffect(() => {
    if (lastRole === "user") follow();
  }, [count, lastRole, follow]);
  // Streaming text: follow only while the reader stays at the bottom.
  useEffect(() => {
    if (followRef.current) scrollToBottom();
  }, [count, lastText, state.streaming, scrollToBottom]);

  const activeModel = conversation.pinnedModel ?? conversation.modelId;

  // Model picker at the bottom of the chat, next to the composer (same place as Claude.ai).
  const modelPicker = (
    <>
      <label htmlFor="chat-model" className="visually-hidden">
        Model for this conversation
      </label>
      <select
        id="chat-model"
        className="model-switch"
        value={conversation.modelAlias}
        disabled={state.streaming || loading}
        onChange={(e) => onChangeModel(e.target.value)}
        title="Change the model for the next messages"
      >
        {available.map((m) => (
          <option key={m.alias} value={m.alias}>
            {m.label}
          </option>
        ))}
      </select>
      {conversation.pinnedModel && conversation.pinnedModel !== conversation.modelId && (
        <span className="muted small">(answering with {modelLabel(models, activeModel)})</span>
      )}
    </>
  );

  return (
    <section className="chat" aria-label="Conversation" ref={chatRef}>
      <header className="chat-head">
        <h1 className="chat-title" title={conversation.title}>
          {conversation.title}
        </h1>
        {projectName && (
          <button type="button" className="badge badge-project" onClick={onOpenProject} title="Open project">
            {projectName}
          </button>
        )}
        {shared && (
          <span className="muted small chat-shared" title="Everyone in this shared project sees this conversation">
            Shared{conversation.createdByName ? ` · started by ${conversation.createdByName}` : ""}
          </span>
        )}
      </header>

      <div className="chat-body">
        <div className="chat-list" ref={listRef} onScroll={onScroll} role="log" aria-live="polite" aria-busy={loading || state.streaming}>
          {loading ? (
            <p className="muted center">Loading conversation…</p>
          ) : state.messages.length === 0 ? (
            <p className="muted center">Type your first message to get started.</p>
          ) : (
            state.messages.map((m) => <MessageBubble key={m.id} message={m} models={models} onRetry={onRetry} showAuthor={shared} exportTitle={conversation.title} />)
          )}
          {state.transportError && !state.messages.some((m) => m.error) && (
            <p className="notice notice-error" role="alert">
              {state.transportError}
            </p>
          )}
        </div>
        {!atBottom && count > 0 && (
          <button type="button" className="jump-latest" onClick={follow} aria-label="Jump to the latest message">
            ↓ {state.streaming ? "New text" : "Latest"}
          </button>
        )}
      </div>

      <Composer
        conversationId={conversation.id}
        attachments={me.limits.attachments?.enabled ? me.limits.attachments : null}
        maxChars={me.limits.maxMessageChars}
        streaming={state.streaming}
        disabled={loading}
        onSend={onSend}
        onStop={onStop}
        leading={modelPicker}
        dropZone={chatRef}
      />
    </section>
  );
}
