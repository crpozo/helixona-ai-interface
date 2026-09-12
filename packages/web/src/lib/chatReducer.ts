import type { ChatSseEvent, ContentBlock, FallbackReason, Message, SseError } from "./types";

export type MessageStatus =
  | "pending" // enviado, esperando message_start / primer texto
  | "streaming" // recibiendo texto
  | "done"
  | "incomplete" // error con partial=true o detenido por el usuario
  | "error" // error sin texto
  | "refused";

export interface Notice {
  kind: "fallback" | "model_switched" | "truncated" | "stopped";
  model?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  /** Modelo que sirvió (o está sirviendo) la respuesta. */
  model: string | null;
  status: MessageStatus;
  notices: Notice[];
  error: SseError | null;
  refusalCategory: string | null;
  stopReason: string | null;
  /** Texto del usuario que originó este turno, para "Reintentar". */
  retryText: string | null;
}

export interface ChatState {
  conversationId: string | null;
  messages: ChatMessage[];
  /** Hay un turno en curso (fetch abierto). */
  streaming: boolean;
  /** Id local de la burbuja del asistente en curso. */
  activeAssistantId: string | null;
  /** Error de transporte (red, 4xx) fuera del flujo SSE. */
  transportError: string | null;
}

export const initialChatState: ChatState = {
  conversationId: null,
  messages: [],
  streaming: false,
  activeAssistantId: null,
  transportError: null,
};

export type ChatAction =
  | { type: "reset" }
  | { type: "load"; conversationId: string; messages: Message[] }
  | { type: "send"; text: string; userId: string; assistantId: string }
  | { type: "sse"; event: ChatSseEvent }
  | { type: "stopped" }
  | { type: "transport_error"; message: string }
  | { type: "finish" }
  | { type: "remove_failed_turn"; assistantId: string };

function blockText(block: ContentBlock): string {
  if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
    return (block as { text: string }).text;
  }
  return "";
}
function blockThinking(block: ContentBlock): string {
  if (block.type !== "thinking") return "";
  const b = block as { thinking?: unknown; text?: unknown };
  if (typeof b.thinking === "string") return b.thinking;
  if (typeof b.text === "string") return b.text;
  return "";
}

function noticeForFallback(reason: FallbackReason | null, model: string | null): Notice[] {
  if (!reason || !model) return [];
  return [{ kind: reason === "refusal" ? "fallback" : "model_switched", model }];
}

export function fromServerMessage(m: Message): ChatMessage {
  const notices = m.role === "assistant" ? noticeForFallback(m.fallbackReason, m.model) : [];
  if (m.role === "assistant" && m.stopReason === "max_tokens") notices.push({ kind: "truncated" });
  return {
    id: m.id,
    role: m.role,
    text: m.content.map(blockText).join(""),
    thinking: m.content.map(blockThinking).join(""),
    model: m.model,
    status: "done",
    notices,
    error: null,
    refusalCategory: null,
    stopReason: m.stopReason,
    retryText: null,
  };
}

function updateActive(state: ChatState, fn: (m: ChatMessage) => ChatMessage): ChatState {
  if (!state.activeAssistantId) return state;
  const id = state.activeAssistantId;
  return {
    ...state,
    messages: state.messages.map((m) => (m.id === id ? fn(m) : m)),
  };
}

function applySse(state: ChatState, event: ChatSseEvent): ChatState {
  switch (event.type) {
    case "message_start": {
      const { userMessageId, assistantMessageId, model } = event.data;
      const active = state.activeAssistantId;
      const idx = state.messages.findIndex((m) => m.id === active);
      const userIdx = idx - 1;
      const messages = state.messages.map((m, i) => {
        if (i === userIdx && m.role === "user") return { ...m, id: userMessageId };
        if (i === idx) return { ...m, id: assistantMessageId, model, status: "pending" as const };
        return m;
      });
      return { ...state, messages, activeAssistantId: idx >= 0 ? assistantMessageId : active };
    }
    case "text_delta":
      return updateActive(state, (m) => ({
        ...m,
        text: m.text + event.data.text,
        status: m.status === "pending" ? "streaming" : m.status,
      }));
    case "thinking_delta":
      return updateActive(state, (m) => ({ ...m, thinking: m.thinking + event.data.text }));
    case "fallback":
      // El texto ya emitido se conserva; el nuevo modelo continúa.
      return updateActive(state, (m) => ({
        ...m,
        model: event.data.to,
        notices: [...m.notices, { kind: "fallback", model: event.data.to }],
      }));
    case "model_switched":
      return updateActive(state, (m) => ({
        ...m,
        model: event.data.to,
        notices: [...m.notices, { kind: "model_switched", model: event.data.to }],
      }));
    case "refused":
      // Se descarta lo parcial y se muestra un mensaje neutro.
      return updateActive(state, (m) => ({
        ...m,
        text: "",
        thinking: "",
        status: "refused",
        refusalCategory: event.data.category ?? null,
      }));
    case "error":
      return updateActive(state, (m) => ({
        ...m,
        error: event.data,
        status: event.data.partial ? "incomplete" : "error",
        // Si no hubo texto parcial, no hay nada que conservar.
        text: event.data.partial ? m.text : "",
      }));
    case "done": {
      const { assistantMessageId, model, stopReason, fallbackReason } = event.data;
      const next = updateActive(state, (m) => {
        const terminal = m.status === "refused" || m.status === "error" || m.status === "incomplete";
        const notices = [...m.notices];
        if (stopReason === "max_tokens" && !notices.some((n) => n.kind === "truncated")) {
          notices.push({ kind: "truncated" });
        }
        return {
          ...m,
          id: assistantMessageId || m.id,
          model: model || m.model,
          stopReason,
          status: terminal ? m.status : "done",
          notices,
          // Si el servidor informa un fallback que no vimos como evento, lo reflejamos.
          ...(fallbackReason && !notices.some((n) => n.kind === "fallback" || n.kind === "model_switched")
            ? { notices: [...notices, ...noticeForFallback(fallbackReason, model)] }
            : {}),
        };
      });
      return { ...next, activeAssistantId: assistantMessageId || next.activeAssistantId };
    }
    default:
      return state;
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "reset":
      return initialChatState;
    case "load":
      return {
        ...initialChatState,
        conversationId: action.conversationId,
        messages: action.messages.map(fromServerMessage),
      };
    case "send": {
      const user: ChatMessage = {
        id: action.userId,
        role: "user",
        text: action.text,
        thinking: "",
        model: null,
        status: "done",
        notices: [],
        error: null,
        refusalCategory: null,
        stopReason: null,
        retryText: null,
      };
      const assistant: ChatMessage = {
        id: action.assistantId,
        role: "assistant",
        text: "",
        thinking: "",
        model: null,
        status: "pending",
        notices: [],
        error: null,
        refusalCategory: null,
        stopReason: null,
        retryText: action.text,
      };
      return {
        ...state,
        messages: [...state.messages, user, assistant],
        streaming: true,
        activeAssistantId: action.assistantId,
        transportError: null,
      };
    }
    case "sse":
      return applySse(state, action.event);
    case "stopped": {
      const next = updateActive(state, (m) =>
        m.status === "pending" || m.status === "streaming"
          ? { ...m, status: "incomplete", notices: [...m.notices, { kind: "stopped" }] }
          : m,
      );
      return { ...next, streaming: false, activeAssistantId: null };
    }
    case "transport_error": {
      const next = updateActive(state, (m) =>
        m.status === "pending" || m.status === "streaming"
          ? {
              ...m,
              status: m.text ? "incomplete" : "error",
              error: { code: "network", message: action.message, retryable: true, partial: m.text.length > 0 },
            }
          : m,
      );
      return { ...next, streaming: false, activeAssistantId: null, transportError: action.message };
    }
    case "finish": {
      // El flujo terminó sin `done` explícito: cerramos lo que quede abierto.
      const next = updateActive(state, (m) =>
        m.status === "pending" || m.status === "streaming"
          ? { ...m, status: m.text ? "done" : "error", error: m.text ? m.error : { code: "internal", message: "El servidor cerró la conexión sin responder.", retryable: true, partial: false } }
          : m,
      );
      return { ...next, streaming: false, activeAssistantId: null };
    }
    case "remove_failed_turn": {
      const idx = state.messages.findIndex((m) => m.id === action.assistantId);
      if (idx === -1) return state;
      const start = idx > 0 && state.messages[idx - 1]?.role === "user" ? idx - 1 : idx;
      return { ...state, messages: [...state.messages.slice(0, start), ...state.messages.slice(idx + 1)] };
    }
    default:
      return state;
  }
}
