import { describe, expect, it } from "vitest";
import { normalizeAssistantContent, toMessageParams } from "../src/history.js";
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
