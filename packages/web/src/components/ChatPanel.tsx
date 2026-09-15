import { useEffect, useRef } from "react";
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
}

export function ChatPanel({ me, conversation, projectName, state, loading, onSend, onStop, onRetry, onChangeModel, onOpenProject }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const models = me.catalog.models;
  const available = models.filter((m) => m.available !== false);
  const lastText = state.messages[state.messages.length - 1]?.text.length ?? 0;

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom || state.streaming) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, lastText, state.streaming]);

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
    <section className="chat" aria-label="Conversation">
      <header className="chat-head">
        <h1 className="chat-title" title={conversation.title}>
          {conversation.title}
        </h1>
        {projectName && (
          <button type="button" className="badge badge-project" onClick={onOpenProject} title="Open project">
            {projectName}
          </button>
        )}
      </header>

      <div className="chat-list" ref={listRef} role="log" aria-live="polite" aria-busy={loading || state.streaming}>
        {loading ? (
          <p className="muted center">Loading conversation…</p>
        ) : state.messages.length === 0 ? (
          <p className="muted center">Type your first message to get started.</p>
        ) : (
          state.messages.map((m) => <MessageBubble key={m.id} message={m} models={models} onRetry={onRetry} />)
        )}
        {state.transportError && !state.messages.some((m) => m.error) && (
          <p className="notice notice-error" role="alert">
            {state.transportError}
          </p>
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
      />
    </section>
  );
}
