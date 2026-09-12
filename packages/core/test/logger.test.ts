import { describe, expect, it } from "vitest";
import { createSafeLogger, ForbiddenLogKeyError } from "../src/logger.js";

const PHI = "Juan Pérez, DNI 12345678, diagnóstico: diabetes";

describe("logger sin PHI", () => {
  it("en modo estricto lanza error ante claves de contenido", () => {
    const log = createSafeLogger({ strict: true, sink: () => {} });
    expect(() => log.info("x", { content: PHI } as never)).toThrow(ForbiddenLogKeyError);
    expect(() => log.info("x", { messages: PHI } as never)).toThrow(ForbiddenLogKeyError);
    expect(() => log.info("x", { text: PHI } as never)).toThrow(ForbiddenLogKeyError);
    expect(() => log.info("x", { title: PHI } as never)).toThrow(ForbiddenLogKeyError);
    expect(() => log.info("x", { email: "a@b.c" } as never)).toThrow(ForbiddenLogKeyError);
  });
  it("en modo no estricto omite la clave y nunca escribe el valor", () => {
    const lines: string[] = [];
    const log = createSafeLogger({ sink: (l) => lines.push(l) });
    log.info("turn_done", { model: "m", content: PHI, nested: { a: PHI } } as never);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("Juan");
    expect(lines[0]).toContain("dropped_keys:content,nested");
  });
  it("test de no fuga: ninguna clave permitida transporta PHI con marcador sintético", () => {
    const lines: string[] = [];
    const log = createSafeLogger({ sink: (l) => lines.push(l) });
    const fields = { userId: "u1", conversationId: "c1", model: "m", inputTokens: 10, latencyMs: 5 };
    log.info("turn_done", fields);
    expect(lines.join("\n")).not.toMatch(/PHI-MARKER|Juan/);
  });
});
