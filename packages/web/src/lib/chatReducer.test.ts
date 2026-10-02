import { describe, expect, it } from "vitest";
import { chatReducer, initialChatState, upsertStep, type ChatState } from "./chatReducer";
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
  it("send creates a user bubble and a pending assistant bubble; message_start assigns ids and model", () => {
    const s = started();
    expect(s.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(s.streaming).toBe(true);
    expect(assistant(s).status).toBe("pending");
    expect(assistant(s).model).toBe("anthropic.claude-opus-5");
  });

  it("keeps the steps of an answer: what was read, sent, reasoned and written, with their times", () => {
    let s = started();
    s = sse(s, { type: "step", data: { steps: [{ id: "sheet-1", text: "Read Report.xlsx: 8,500 rows × 17 columns", state: "done" }] } });
    s = sse(s, { type: "files", data: { phase: "checking", files: [{ id: "f", name: "a.pdf", pages: null, pagesDone: 0, state: "checking" }] } });
    s = sse(s, { type: "files", data: { phase: "read", files: [{ id: "f", name: "a.pdf", pages: 12, pagesDone: 12, state: "done" }] } });
    s = sse(s, { type: "status", data: { stage: "waiting", model: "anthropic.claude-opus-5", inputTokens: 380_000 } });
    expect(assistant(s).steps.map((x) => [x.id, x.state, x.text])).toEqual([
      ["sheet-1", "done", "Read Report.xlsx: 8,500 rows × 17 columns"],
      ["files", "done", "Read 1 file (12 pages)"],
      ["send", "running", "Sending about 380k tokens to {model}"],
    ]);
    s = sse(s, { type: "status", data: { stage: "responding", model: "anthropic.claude-opus-5", inputTokens: 380_000 } });
    expect(assistant(s).steps.slice(2).map((x) => [x.id, x.state])).toEqual([["send", "done"], ["reason", "running"]]);
    expect(assistant(s).steps[2]!.ms).not.toBeNull();
    s = sse(s, { type: "text_delta", data: { text: "Here" } });
    expect(assistant(s).steps.slice(3).map((x) => [x.id, x.state, x.text])).toEqual([["reason", "done", "{model} is reasoning over the data"], ["write", "running", "Writing the answer"]]);
    s = sse(s, { type: "done", data: { assistantMessageId: "a1", model: "anthropic.claude-opus-5", stopReason: "end_turn", usage: null, fallbackReason: null } });
    expect(assistant(s).steps.every((x) => x.state === "done" && x.ms !== null)).toBe(true);
    // A step reported again keeps its place and updates.
    const once = upsertStep([], { id: "x", text: "Doing", state: "running" }, 1000);
    expect(upsertStep(once, { id: "x", text: "Done it", state: "done" }, 3500)).toEqual([{ id: "x", text: "Done it", model: null, state: "done", startedAt: 1000, ms: 2500 }]);
  });

  it("status says what the server is waiting for while the answer is pending", () => {
    let s = started();
    s = sse(s, { type: "status", data: { stage: "waiting", model: "anthropic.claude-opus-5", inputTokens: 380_000 } });
    expect(assistant(s).wait).toMatchObject({ stage: "waiting", inputTokens: 380_000 });
    expect(assistant(s).wait!.since).toBeGreaterThan(0);
    s = sse(s, { type: "status", data: { stage: "responding", model: "anthropic.claude-opus-5", inputTokens: 380_000 } });
    expect(assistant(s).wait?.stage).toBe("responding");
    expect(assistant(s).status).toBe("pending");
  });

  it("text_delta moves from pending to streaming and accumulates text", () => {
    let s = started();
    s = sse(s, { type: "text_delta", data: { text: "Hola" } });
    s = sse(s, { type: "text_delta", data: { text: ", mundo" } });
    expect(assistant(s).status).toBe("streaming");
    expect(assistant(s).text).toBe("Hola, mundo");
  });

  it("thinking_delta accumulates reasoning without touching the text", () => {
    let s = started();
    s = sse(s, { type: "thinking_delta", data: { text: "pienso" } });
    expect(assistant(s).thinking).toBe("pienso");
    expect(assistant(s).text).toBe("");
  });

  it("fallback keeps the text already received and switches the model with a notice", () => {
    let s = started();
    s = sse(s, { type: "text_delta", data: { text: "parcial" } });
    s = sse(s, { type: "fallback", data: { from: "anthropic.claude-opus-5", to: "anthropic.claude-opus-4-8", reason: "refusal" } });
    s = sse(s, { type: "text_delta", data: { text: " continuado" } });
    const a = assistant(s);
    expect(a.text).toBe("parcial continuado");
    expect(a.model).toBe("anthropic.claude-opus-4-8");
    expect(a.notices).toEqual([{ kind: "fallback", model: "anthropic.claude-opus-4-8" }]);
  });

  it("model_switched records an availability notice", () => {
    let s = started();
    s = sse(s, { type: "model_switched", data: { from: "a", to: "b", reason: "availability" } });
    expect(assistant(s).notices).toEqual([{ kind: "model_switched", model: "b" }]);
    expect(assistant(s).model).toBe("b");
  });

  it("refused discards the partial text and stores the category", () => {
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

  it("error with partial=true marks incomplete and keeps the text", () => {
    let s = started();
    s = sse(s, { type: "text_delta", data: { text: "mitad" } });
    s = sse(s, { type: "error", data: { code: "internal", message: "x", retryable: true, partial: true } });
    expect(assistant(s).status).toBe("incomplete");
    expect(assistant(s).text).toBe("mitad");
    expect(assistant(s).error?.code).toBe("internal");
    expect(assistant(s).retryText).toBe("hola");
  });

  it("error without partial marks error and leaves the text empty", () => {
    let s = started();
    s = sse(s, { type: "error", data: { code: "quota_exceeded", message: "x", retryable: false, partial: false } });
    expect(assistant(s).status).toBe("error");
    expect(assistant(s).text).toBe("");
    s = chatReducer(s, { type: "finish" });
    expect(s.streaming).toBe(false);
    expect(assistant(s).status).toBe("error");
  });

  it("done sets model, stopReason and a truncation notice", () => {
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

  it("stopped marks the in-progress message as incomplete", () => {
    let s = started();
    s = sse(s, { type: "text_delta", data: { text: "t" } });
    s = chatReducer(s, { type: "stopped" });
    expect(assistant(s).status).toBe("incomplete");
    expect(assistant(s).notices).toEqual([{ kind: "stopped" }]);
    expect(s.streaming).toBe(false);
  });

  it("remove_failed_turn removes the assistant bubble and the preceding user bubble", () => {
    let s = started();
    s = sse(s, { type: "error", data: { code: "internal", message: "x", retryable: true, partial: false } });
    s = chatReducer(s, { type: "finish" });
    s = chatReducer(s, { type: "remove_failed_turn", assistantId: "a1" });
    expect(s.messages).toEqual([]);
  });

  it("load converts server messages (text/thinking blocks, fallback)", () => {
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

describe("a turn that uses tools", () => {
  it("moves the remark before a tool call into the steps, shows the call, and numbers the next round's work", () => {
    let s = started();
    s = sse(s, { type: "status", data: { stage: "waiting", model: "m", inputTokens: 1200 } });
    s = sse(s, { type: "status", data: { stage: "responding", model: "m", inputTokens: 1200 } });
    s = sse(s, { type: "text_delta", data: { text: "Let me read the files first." } });
    expect(assistant(s).status).toBe("streaming");
    s = sse(s, { type: "round", data: { round: 1, note: "Let me read the files first." } });
    expect(assistant(s).text).toBe("");
    expect(assistant(s).status).toBe("pending");
    expect(assistant(s).round).toBe(2);
    expect(assistant(s).steps.map((x) => [x.id, x.state])).toEqual([["send", "done"], ["reason", "done"], ["write", "done"], ["note-1", "done"]]);
    expect(assistant(s).steps.at(-1)!.text).toBe("“Let me read the files first.”");
    s = sse(s, { type: "step", data: { steps: [{ id: "toolu_1", text: "Reading 1 file from EOBs.zip: Checks.csv", state: "running" }] } });
    s = sse(s, { type: "step", data: { steps: [{ id: "toolu_1", text: "Read 1 file from EOBs.zip: Checks.csv", state: "done" }] } });
    s = sse(s, { type: "status", data: { stage: "waiting", model: "m", inputTokens: 1400 } });
    s = sse(s, { type: "status", data: { stage: "responding", model: "m", inputTokens: 1400 } });
    s = sse(s, { type: "text_delta", data: { text: "Ana was paid $10." } });
    const ids = assistant(s).steps.map((x) => x.id);
    expect(ids).toEqual(["send", "reason", "write", "note-1", "toolu_1", "send-2", "reason-2", "write-2"]);
    expect(assistant(s).steps.find((x) => x.id === "send-2")!.text).toBe("Sending what was read to {model}");
    expect(assistant(s).text).toBe("Ana was paid $10.");
    s = sse(s, { type: "done", data: { assistantMessageId: "a1", model: "m", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0 }, fallbackReason: null } });
    expect(assistant(s).status).toBe("done");
    expect(assistant(s).steps.every((x) => x.state === "done")).toBe(true);
  });

  it("a loaded answer that used tools brings its activity list back", () => {
    const msg: Message = { id: "a", role: "assistant", content: [{ type: "text", text: "Ana was paid $10." }], model: "m", fallbackReason: null, stopReason: "end_turn", usage: null, createdAt: "2026-10-02T00:00:00Z", tools: { steps: [{ text: "“Let me read the files first.”", ms: 0 }, { text: "Read 1 file from EOBs.zip: Checks.csv", ms: 120 }] } };
    const s = chatReducer(initialChatState, { type: "load", conversationId: "c", messages: [msg] });
    expect(s.messages[0]!.steps.map((x) => [x.text, x.ms, x.state])).toEqual([["“Let me read the files first.”", 0, "done"], ["Read 1 file from EOBs.zip: Checks.csv", 120, "done"]]);
  });
});
