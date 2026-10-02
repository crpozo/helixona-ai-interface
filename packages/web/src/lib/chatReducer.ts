import type { AttachmentMeta, ChatSseEvent, ContentBlock, FallbackReason, Message, SseError, SseFiles } from "./types";

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
  /** Texto del usuario que originó este turno, para "Retry". */
  retryText: string | null;
  /** Files attached to this user turn (empty for assistant turns). */
  attachments: AttachmentMeta[];
  /** Attachments of the user turn that produced this response, for "Retry". */
  retryAttachments: AttachmentMeta[];
  /** Who wrote a user turn; named in shared projects, where several people write in one conversation. */
  authorName: string | null;
  /** Large files the server checked or read page by page before this answer (this session only). */
  files: SseFiles | null;
  /** What the server is waiting for while the answer is pending, and since when (this session only). */
  wait: { stage: "waiting" | "responding"; inputTokens: number | null; since: number } | null;
  /** What was done for this answer, step by step, with how long each took (this session only). */
  steps: Step[];
}

export interface Step {
  id: string;
  /** What is being done; "{model}" stands for the model's name, which the interface fills in. */
  text: string;
  model: string | null;
  state: "running" | "done";
  startedAt: number;
  /** Milliseconds it took, once done. */
  ms: number | null;
}

/** Adds a step or updates the one with the same id; a step that finishes keeps the time it took. */
export function upsertStep(steps: Step[], step: { id: string; text: string; model?: string | null; state: "running" | "done" }, now = Date.now()): Step[] {
  const i = steps.findIndex((s) => s.id === step.id);
  if (i < 0) return [...steps, { id: step.id, text: step.text, model: step.model ?? null, state: step.state, startedAt: now, ms: step.state === "done" ? 0 : null }];
  const prev = steps[i]!;
  const next: Step = { ...prev, text: step.text, model: step.model ?? prev.model, state: step.state, ms: step.state === "done" ? (prev.state === "done" ? prev.ms : now - prev.startedAt) : null };
  return steps.map((s, k) => (k === i ? next : s));
}

export function finishSteps(steps: Step[], now = Date.now()): Step[] {
  return steps.map((s) => (s.state === "running" ? { ...s, state: "done" as const, ms: now - s.startedAt } : s));
}

function filesStep(files: SseFiles): { id: string; text: string; state: "running" | "done" } {
  const n = files.files.length;
  const noun = n === 1 ? "file" : "files";
  const pages = files.files.reduce((k, f) => k + (f.pages ?? 0), 0);
  const done = files.files.reduce((k, f) => k + f.pagesDone, 0);
  if (files.phase === "checking") return { id: "files", text: `Checking ${n} ${noun}`, state: "running" };
  if (files.phase === "reading") return { id: "files", text: `Reading ${n} ${noun} page by page: ${done.toLocaleString("en-US")} of ${pages.toLocaleString("en-US")} pages`, state: "running" };
  return { id: "files", text: `Read ${n} ${noun}${pages > 0 ? ` (${pages.toLocaleString("en-US")} pages)` : ""}`, state: "done" };
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
  | { type: "send"; text: string; userId: string; assistantId: string; attachments?: AttachmentMeta[]; authorName?: string }
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
  if (m.role === "assistant" && m.stopReason === "stopped") notices.push({ kind: "stopped" });
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
    attachments: m.attachments ?? [],
    retryAttachments: [],
    authorName: m.authorName ?? null,
    files: null,
    wait: null,
    steps: [],
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
        // The first text: whatever was running (reasoning, sending) is over; the answer is being written.
        steps: m.status === "pending" && m.steps.length > 0 ? upsertStep(finishSteps(m.steps), { id: "write", text: "Writing the answer", state: "running" }) : m.steps,
      }));
    case "thinking_delta":
      return updateActive(state, (m) => ({ ...m, thinking: m.thinking + event.data.text }));
    case "status": {
      const { stage, model, inputTokens } = event.data;
      const big = (inputTokens ?? 0) >= 100_000;
      return updateActive(state, (m) => {
        let steps = m.steps;
        if (stage === "waiting") steps = upsertStep(steps, { id: "send", text: big ? `Sending about ${Math.round(inputTokens! / 1000).toLocaleString("en-US")}k tokens to {model}` : "Sending the request to {model}", model, state: "running" });
        else {
          const sent = steps.find((s) => s.id === "send");
          if (sent) steps = upsertStep(steps, { id: "send", text: sent.text, state: "done" });
          steps = upsertStep(steps, { id: "reason", text: big ? "{model} is reasoning over the data" : "{model} is reasoning", model, state: "running" });
        }
        return { ...m, wait: { stage, inputTokens, since: Date.now() }, steps };
      });
    }
    case "step":
      return updateActive(state, (m) => ({ ...m, steps: event.data.steps.reduce((acc, s) => upsertStep(acc, s), m.steps) }));
    case "files":
      // A snapshot: the list replaces the previous one; an empty list clears it.
      return updateActive(state, (m) => ({ ...m, files: event.data.files.length > 0 ? event.data : null, steps: event.data.files.length > 0 ? upsertStep(m.steps, filesStep(event.data)) : m.steps }));
    case "fallback":
      // El texto ya emitido se conserva; el nuevo modelo continúa.
      return updateActive(state, (m) => ({
        ...m,
        model: event.data.to,
        notices: [...m.notices, { kind: "fallback", model: event.data.to }],
        steps: upsertStep(m.steps, { id: `switch-${event.data.to}`, text: "{model} continues the answer", model: event.data.to, state: "done" }),
      }));
    case "model_switched":
      return updateActive(state, (m) => ({
        ...m,
        model: event.data.to,
        notices: [...m.notices, { kind: "model_switched", model: event.data.to }],
        steps: upsertStep(finishSteps(m.steps), { id: `switch-${event.data.to}`, text: "No answer in time; continuing with {model}", model: event.data.to, state: "done" }),
      }));
    case "refused":
      // Se descarta lo parcial y se muestra un mensaje neutro.
      return updateActive(state, (m) => ({
        ...m,
        text: "",
        thinking: "",
        status: "refused",
        refusalCategory: event.data.category ?? null,
        steps: finishSteps(m.steps),
      }));
    case "error":
      return updateActive(state, (m) => ({
        ...m,
        error: event.data,
        status: event.data.partial ? "incomplete" : "error",
        // Si no hubo texto parcial, no hay nada que conservar.
        text: event.data.partial ? m.text : "",
        steps: finishSteps(m.steps),
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
          steps: finishSteps(m.steps),
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
        attachments: action.attachments ?? [],
        retryAttachments: [],
        authorName: action.authorName ?? null,
        files: null,
    wait: null,
    steps: [],
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
        attachments: [],
        retryAttachments: action.attachments ?? [],
        authorName: null,
        files: null,
    wait: null,
    steps: [],
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
          ? { ...m, status: m.text ? "done" : "error", error: m.text ? m.error : { code: "internal", message: "The server closed the connection without responding.", retryable: true, partial: false } }
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
