import { useEffect, useRef } from "react";
import type { ChatMessage, ChatState } from "../lib/chatReducer";
import type { Conversation, Me } from "../lib/types";
import { modelLabel } from "../lib/models";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";

interface Props {
  me: Me;
  conversation: Conversation;
  state: ChatState;
  loading: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onRetry: (message: ChatMessage) => void;
}

export function ChatPanel({ me, conversation, state, loading, onSend, onStop, onRetry }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const models = me.catalog.models;
  const lastText = state.messages[state.messages.length - 1]?.text.length ?? 0;

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom || state.streaming) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, lastText, state.streaming]);

  const activeModel = conversation.pinnedModel ?? conversation.modelId;

  return (
    <section className="chat" aria-label="Conversation">
      <header className="chat-head">
        <h1 className="chat-title" title={conversation.title}>
          {conversation.title}
        </h1>
        <span className="badge badge-model" title={activeModel}>
          {modelLabel(models, activeModel)}
        </span>
        {conversation.pinnedModel && conversation.pinnedModel !== conversation.modelId && (
          <span className="muted small">
            (selected: {modelLabel(models, conversation.modelId)})
          </span>
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
        maxChars={me.limits.maxMessageChars}
        streaming={state.streaming}
        disabled={loading}
        onSend={onSend}
        onStop={onStop}
      />
    </section>
  );
}
