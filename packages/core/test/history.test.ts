import { describe, expect, it } from "vitest";
import { estimateAttachmentTokens, normalizeAssistantContent, toMessageParams, withoutRounds } from "../src/history.js";
import type { StoredMessage } from "../src/types.js";

const fb = { type: "fallback", from: { model: "a" }, to: { model: "b" } } as never;

describe("historial", () => {
  it("sin fallback: contenido íntegro (append-only)", () => {
    const c = [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: "hola", citations: null }] as never[];
    expect(normalizeAssistantContent(c)).toEqual(c);
  });
  it("con fallback a mitad de salida: omite thinking/tool_use anteriores al último bloque fallback", () => {
    const c = [
      { type: "thinking", thinking: "", signature: "x" },
      { type: "text", text: "parcial", citations: null },
      { type: "tool_use", id: "t", name: "n", input: {} },
      fb,
      { type: "thinking", thinking: "", signature: "y" },
      { type: "text", text: "resto", citations: null },
    ] as never[];
    const out = normalizeAssistantContent(c);
    expect(out.map((b) => b.type)).toEqual(["text", "fallback", "thinking", "text"]);
  });
  it("toMessageParams omite textos vacíos y mensajes vacíos", () => {
    const msgs: StoredMessage[] = [
      { id: "1", conversationId: "c", seq: 1, role: "user", content: [{ type: "text", text: "hola" }], model: null, fallbackReason: null, stopReason: null, usage: null, createdAt: "" },
      { id: "2", conversationId: "c", seq: 2, role: "assistant", content: [{ type: "text", text: "", citations: null } as never], model: "m", fallbackReason: null, stopReason: null, usage: null, createdAt: "" },
    ];
    expect(toMessageParams(msgs)).toEqual([{ role: "user", content: [{ type: "text", text: "hola" }] }]);
  });
});

describe("attachment size for the context check", () => {
  it("uses the size of the text the model receives when it is known, otherwise a guess from the file", () => {
    const base = { id: "a", name: "Report.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 5_600_000, pages: null, key: "k" };
    // A 5.6 MB workbook guessed from its size would never fit; measured, it does.
    expect(estimateAttachmentTokens(base)).toBe(16_000_000);
    expect(estimateAttachmentTokens({ ...base, modelChars: 700_000 })).toBe(200_000);
    expect(estimateAttachmentTokens({ ...base, name: "a.pdf", contentType: "application/pdf", pages: 3 })).toBe(6_000);
    expect(estimateAttachmentTokens({ ...base, name: "a.txt", contentType: "text/plain", size: 350 })).toBe(100);
  });
});

describe("tool rounds in the history", () => {
  const base = { conversationId: "c", model: "m", fallbackReason: null, stopReason: "end_turn", usage: null, createdAt: "2026-10-02T00:00:00Z" } as const;
  const assistant: StoredMessage = {
    ...base,
    id: "a1",
    seq: 2,
    role: "assistant",
    rounds: [{ assistant: [{ type: "text", text: "Let me look.", citations: null }, { type: "tool_use", id: "t1", name: "read_zip_files", input: { attachment: "x.zip", paths: ["a.txt"] } }] as never, results: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a" }] }] }],
    content: [{ type: "thinking", thinking: "", signature: "s" }, { type: "text", text: "a says a.", citations: null }] as never,
    tools: { key: "conversations/c/tools/a1.json", steps: [{ text: "Read 1 file from x.zip: a.txt", ms: 12 }] },
  };
  const user: StoredMessage = { ...base, id: "u1", seq: 1, role: "user", content: [{ type: "text", text: "what does a say?" }] as never, model: null, stopReason: null };

  it("replays a turn that used tools round by round, then its answer", () => {
    const out = toMessageParams([user, assistant]);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect((out[1]!.content as Array<{ type: string }>).map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect((out[2]!.content as Array<{ type: string }>).map((b) => b.type)).toEqual(["tool_result"]);
    expect((out[3]!.content as Array<{ type: string }>).map((b) => b.type)).toEqual(["thinking", "text"]);
  });

  it("an older tool turn keeps its answer only: no rounds, no thinking bound to them", () => {
    const slim = withoutRounds(assistant);
    expect(slim.rounds).toBeUndefined();
    expect(slim.tools).toEqual(assistant.tools);
    expect((slim.content as Array<{ type: string }>).map((b) => b.type)).toEqual(["text"]);
    expect(toMessageParams([user, slim]).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});
