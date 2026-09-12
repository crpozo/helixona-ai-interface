import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState, type ChatState } from "./chatReducer";
import type { ChatSseEvent, Message } from "./types";

function started(): ChatState {
  let s = chatReducer(initialChatState, { type: "load", conversationId: "c1", messages: [] });
  s = chatReducer(s, { type: "send", text: "hola", userId: "lu", assistantId: "la" });
  s = chatReducer(s, {
    type: "sse",
    event: { type: "message_start", data: { userMessageId: "u1", assistantMessageId: "a1", model: "anthropic.claude-opus-5" } },
  });
  return s;
}
const sse = (s: ChatState, event: ChatSseEvent) => chatReducer(s, { type: "sse", event });
const assistant = (s: ChatState) => s.messages[s.messages.length - 1]!;

describe("chatReducer", () => {
  it("send crea burbuja de usuario y asistente pendiente; message_start asigna ids y modelo", () => {
    const s = started();
    expect(s.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(s.streaming).toBe(true);
    expect(assistant(s).status).toBe("pending");
    expect(assistant(s).model).toBe("anthropic.claude-opus-5");
  });

  it("text_delta pasa de pendiente a streaming y acumula texto", () => {
    let s = started();
    s = sse(s, { type: "text_delta", data: { text: "Hola" } });
    s = sse(s, { type: "text_delta", data: { text: ", mundo" } });
    expect(assistant(s).status).toBe("streaming");
    expect(assistant(s).text).toBe("Hola, mundo");
  });

  it("thinking_delta acumula razonamiento sin tocar el texto", () => {
    let s = started();
    s = sse(s, { type: "thinking_delta", data: { text: "pienso" } });
    expect(assistant(s).thinking).toBe("pienso");
    expect(assistant(s).text).toBe("");
  });

  it("fallback conserva el texto ya recibido y cambia el modelo con aviso", () => {
    let s = started();
    s = sse(s, { type: "text_delta", data: { text: "parcial" } });
    s = sse(s, { type: "fallback", data: { from: "anthropic.claude-opus-5", to: "anthropic.claude-opus-4-8", reason: "refusal" } });
    s = sse(s, { type: "text_delta", data: { text: " continuado" } });
    const a = assistant(s);
    expect(a.text).toBe("parcial continuado");
    expect(a.model).toBe("anthropic.claude-opus-4-8");
    expect(a.notices).toEqual([{ kind: "fallback", model: "anthropic.claude-opus-4-8" }]);
  });

  it("model_switched registra aviso de disponibilidad", () => {
    let s = started();
    s = sse(s, { type: "model_switched", data: { from: "a", to: "b", reason: "availability" } });
    expect(assistant(s).notices).toEqual([{ kind: "model_switched", model: "b" }]);
    expect(assistant(s).model).toBe("b");
  });

  it("refused descarta el texto parcial y guarda la categoría", () => {
    let s = started();
    s = sse(s, { type: "text_delta", data: { text: "algo" } });
    s = sse(s, { type: "refused", data: { category: "cyber" } });
    expect(assistant(s).text).toBe("");
    expect(assistant(s).status).toBe("refused");
    expect(assistant(s).refusalCategory).toBe("cyber");
    // done posterior no reabre el mensaje
    s = sse(s, { type: "done", data: { assistantMessageId: "a1", model: "m", stopReason: "refusal", usage: null, fallbackReason: null } });
    expect(assistant(s).status).toBe("refused");
  });

  it("error con partial=true marca incompleto y conserva el texto", () => {
    let s = started();
    s = sse(s, { type: "text_delta", data: { text: "mitad" } });
    s = sse(s, { type: "error", data: { code: "internal", message: "x", retryable: true, partial: true } });
    expect(assistant(s).status).toBe("incomplete");
    expect(assistant(s).text).toBe("mitad");
    expect(assistant(s).error?.code).toBe("internal");
    expect(assistant(s).retryText).toBe("hola");
  });

  it("error sin partial marca error y deja el texto vacío", () => {
    let s = started();
    s = sse(s, { type: "error", data: { code: "quota_exceeded", message: "x", retryable: false, partial: false } });
    expect(assistant(s).status).toBe("error");
    expect(assistant(s).text).toBe("");
    s = chatReducer(s, { type: "finish" });
    expect(s.streaming).toBe(false);
    expect(assistant(s).status).toBe("error");
  });

  it("done fija modelo, stopReason y aviso de truncado", () => {
    let s = started();
    s = sse(s, { type: "text_delta", data: { text: "t" } });
    s = sse(s, { type: "done", data: { assistantMessageId: "a1", model: "anthropic.claude-opus-5", stopReason: "max_tokens", usage: null, fallbackReason: null } });
    s = chatReducer(s, { type: "finish" });
    const a = assistant(s);
    expect(a.status).toBe("done");
    expect(a.stopReason).toBe("max_tokens");
    expect(a.notices).toEqual([{ kind: "truncated" }]);
    expect(s.streaming).toBe(false);
    expect(s.activeAssistantId).toBe(null);
  });

  it("stopped marca el mensaje en curso como incompleto", () => {
    let s = started();
    s = sse(s, { type: "text_delta", data: { text: "t" } });
    s = chatReducer(s, { type: "stopped" });
    expect(assistant(s).status).toBe("incomplete");
    expect(assistant(s).notices).toEqual([{ kind: "stopped" }]);
    expect(s.streaming).toBe(false);
  });

  it("remove_failed_turn quita la burbuja del asistente y la del usuario anterior", () => {
    let s = started();
    s = sse(s, { type: "error", data: { code: "internal", message: "x", retryable: true, partial: false } });
    s = chatReducer(s, { type: "finish" });
    s = chatReducer(s, { type: "remove_failed_turn", assistantId: "a1" });
    expect(s.messages).toEqual([]);
  });

  it("load convierte mensajes del servidor (bloques text/thinking, fallback)", () => {
    const msgs: Message[] = [
      { id: "u", role: "user", content: [{ type: "text", text: "hola" }], model: null, fallbackReason: null, stopReason: null, usage: null, createdAt: "" },
      {
        id: "a",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "respuesta" },
        ],
        model: "anthropic.claude-opus-4-8",
        fallbackReason: "refusal",
        stopReason: "end_turn",
        usage: null,
        createdAt: "",
      },
    ];
    const s = chatReducer(initialChatState, { type: "load", conversationId: "c", messages: msgs });
    expect(s.messages[1]?.text).toBe("respuesta");
    expect(s.messages[1]?.thinking).toBe("hmm");
    expect(s.messages[1]?.notices).toEqual([{ kind: "fallback", model: "anthropic.claude-opus-4-8" }]);
    expect(s.messages[1]?.status).toBe("done");
  });
});
