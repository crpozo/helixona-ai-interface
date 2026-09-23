import { describe, expect, it } from "vitest";
import { ModelRouter } from "../src/llm/router.js";
import { FakeProvider } from "../src/llm/fake-provider.js";
import { DEFAULT_CATALOG } from "../src/catalog.js";
import { CircuitBreaker } from "../src/breaker.js";
import type { LlmProvider, StreamHandle } from "../src/llm/provider.js";
import type { BetaMessage, BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { collect, conv, history, refusalFallbacks } from "./helpers.js";

const mk = (extra: Partial<ConstructorParameters<typeof ModelRouter>[0]> = {}) =>
  new ModelRouter({ catalog: DEFAULT_CATALOG, provider: new FakeProvider({ refusalFallbacks, delayMs: 0 }), firstEventTimeoutMs: 200, ...extra });

describe("ModelRouter", () => {
  it("turno normal en el modelo elegido, sin pin", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv(), history, userText: "hola", systemPrompt: "sistema", emit: c.emit });
    expect(r.ok).toBe(true);
    expect(r.servedModel).toBe("anthropic.claude-fable-5-1");
    expect(r.pin).toBeNull();
    expect(c.events[0]).toEqual({ type: "message_start", model: "anthropic.claude-fable-5-1" });
    expect(c.text()).toContain("Simulated reply");
    const done = c.events.at(-1)!;
    expect(done.type).toBe("done");
    expect(r.usage.estimatedUsd).toBeGreaterThan(0);
  });

  it("rechazo antes de salida: el middleware cae a Opus 5 y la conversación queda fijada por refusal", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv(), history, userText: "/refuse pregunta", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(true);
    expect(r.servedModel).toBe("anthropic.claude-opus-5-5");
    expect(r.fallbackReason).toBe("refusal");
    expect(r.pin).toEqual({ model: "anthropic.claude-opus-5-5", reason: "refusal", until: null });
    expect(c.events.some((e) => e.type === "fallback")).toBe(true);
  });

  it("rechazo a mitad de salida: conserva el texto parcial y continúa", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv(), history, userText: "/refuse-mid pregunta", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(true);
    const fbIdx = c.events.findIndex((e) => e.type === "fallback");
    expect(fbIdx).toBeGreaterThan(0);
    expect(c.events.slice(0, fbIdx).some((e) => e.type === "text_delta")).toBe(true);
    expect(c.events.slice(fbIdx).some((e) => e.type === "text_delta")).toBe(true);
    expect(r.content.some((b) => b.type === "fallback")).toBe(true);
  });

  it("toda la cadena rechaza: evento refused y sin pin", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv(), history, userText: "/refuse-all x", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(false);
    expect(r.stopReason).toBe("refusal");
    expect(r.refusalCategory).toBe("bio");
    expect(c.events.at(-1)).toEqual({ type: "refused", category: "bio" });
  });

  it("sonnet elegido: sin respaldo, un rechazo total se reporta", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv({ modelAlias: "sonnet" }), history, userText: "/refuse x", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(false);
    expect(c.events.at(-1)?.type).toBe("refused");
  });

  it("throttling antes de salida: cae a Opus 5 por disponibilidad con pin blando", async () => {
    const c = collect();
    const now = new Date("2026-09-12T10:00:00Z");
    const r = await mk({ now: () => now }).runTurn({ conversation: conv(), history, userText: "/throttle x", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(true);
    expect(r.servedModel).toBe("anthropic.claude-opus-5-5");
    expect(r.fallbackReason).toBe("availability");
    expect(r.pin?.reason).toBe("availability");
    expect(r.pin?.until).toBe("2026-09-12T10:15:00.000Z");
    expect(c.events.some((e) => e.type === "model_switched")).toBe(true);
  });

  it("error después de emitir texto: no sustituye en silencio, error parcial", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv(), history, userText: "/throttle-mid x", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(false);
    const last = c.events.at(-1)!;
    expect(last.type).toBe("error");
    expect((last as { partial: boolean }).partial).toBe(true);
    expect(c.events.some((e) => e.type === "model_switched")).toBe(false);
  });

  it("opus elegido y throttling: cae a Opus 5 por disponibilidad", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv({ modelAlias: "opus" }), history, userText: "/throttle x", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(true);
    expect(r.servedModel).toBe("anthropic.claude-opus-5");
    expect(r.pin?.reason).toBe("availability");
  });

  it("sonnet elegido y throttling: no hay respaldo por disponibilidad → error model_unavailable", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv({ modelAlias: "sonnet" }), history, userText: "/throttle x", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(false);
    expect((c.events.at(-1) as { code: string }).code).toBe("model_unavailable");
  });

  it("sin primer evento: timeout de primer evento dispara el respaldo", async () => {
    const c = collect();
    const r = await mk({ firstEventTimeoutMs: 50 }).runTurn({ conversation: conv(), history, userText: "/hang x", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(true);
    expect(r.servedModel).toBe("anthropic.claude-opus-5-5");
  });

  it("pin por refusal vigente: empieza directamente en Opus 5", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv({ pinnedModel: "anthropic.claude-opus-5-5", pinReason: "refusal" }), history, userText: "hola", systemPrompt: "s", emit: c.emit });
    expect(c.events[0]).toEqual({ type: "message_start", model: "anthropic.claude-opus-5-5" });
    expect(r.servedModel).toBe("anthropic.claude-opus-5-5");
  });

  it("pin blando vencido: vuelve a Fable", async () => {
    const c = collect();
    const past = new Date(Date.now() - 60_000).toISOString();
    const r = await mk().runTurn({ conversation: conv({ pinnedModel: "anthropic.claude-opus-5-5", pinReason: "availability", pinnedUntil: past }), history, userText: "hola", systemPrompt: "s", emit: c.emit });
    expect(r.servedModel).toBe("anthropic.claude-fable-5-1");
  });

  it("breaker abierto para Fable: las conversaciones nuevas empiezan en Opus 5", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("anthropic.claude-fable-5-1");
    const c = collect();
    const r = await mk({ breaker }).runTurn({ conversation: conv(), history, userText: "hola", systemPrompt: "s", emit: c.emit });
    expect(c.events[0]).toEqual({ type: "model_switched", from: "anthropic.claude-fable-5-1", to: "anthropic.claude-opus-5-5", reason: "availability" });
    expect(r.servedModel).toBe("anthropic.claude-opus-5-5");
    expect(r.pin?.reason).toBe("availability");
  });

  it("respuesta truncada: done con stopReason max_tokens", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv(), history, userText: "/long x", systemPrompt: "s", emit: c.emit });
    expect(r.stopReason).toBe("max_tokens");
  });

  it("los parámetros de la request no llevan thinking ni sampling y sí effort medium con caché de 1h", () => {
    const p = mk().buildParams("anthropic.claude-fable-5-1", "sistema", history, "hola");
    expect(p.effort).toBe("medium");
    expect(p.thinking).toBeUndefined();
    expect((p as unknown as Record<string, unknown>)["temperature"]).toBeUndefined();
    expect(p.system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(p.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "hola" }] });
  });

  it("cancelación por el cliente: error aborted", async () => {
    const c = collect();
    const ac = new AbortController();
    const slow: LlmProvider = new FakeProvider({ refusalFallbacks, delayMs: 20 });
    const p = new ModelRouter({ catalog: DEFAULT_CATALOG, provider: slow }).runTurn({ conversation: conv(), history, userText: "hola", systemPrompt: "s", emit: c.emit, signal: ac.signal });
    setTimeout(() => ac.abort(), 60);
    const r = await p;
    expect(r.ok).toBe(false);
    expect((c.events.at(-1) as { code: string }).code).toBe("aborted");
    // The partial answer and the model that gave it come back, so the caller can keep the turn.
    expect(r.partial).toBe(true);
    expect(r.servedModel).toBe("anthropic.claude-fable-5-1");
    expect(r.content.map((b) => (b.type === "text" ? b.text : "")).join("").length).toBeGreaterThan(0);
  });
});

/** Provider that reports the Anthropic API's bare ids (`claude-sonnet-5`) instead of the catalog's `anthropic.` ids. */
function bareIdProvider(): LlmProvider {
  return {
    stream(params): StreamHandle {
      const bare = params.model.replace(/^anthropic\./, "");
      const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const events = [
        { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: bare, content: [], stop_reason: null, stop_sequence: null, usage } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hola" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ] as unknown as BetaRawMessageStreamEvent[];
      return {
        async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
        async finalMessage() {
          return { id: "m", type: "message", role: "assistant", model: bare, content: [{ type: "text", text: "hola", citations: null }], stop_reason: "end_turn", stop_sequence: null, usage } as unknown as BetaMessage;
        },
        abort() {},
      };
    },
  };
}

describe("ModelRouter: provider model ids", () => {
  it("an answer served under the API's bare id is not a fallback: no pin, catalog id in events, priced", async () => {
    const c = collect();
    const r = await mk({ provider: bareIdProvider() }).runTurn({ conversation: conv({ modelAlias: "sonnet" }), history, userText: "hola", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(true);
    expect(r.servedModel).toBe("anthropic.claude-sonnet-5");
    expect(r.fallbackReason).toBeNull();
    expect(r.pin).toBeNull();
    expect(c.events.some((e) => e.type === "fallback")).toBe(false);
    expect(c.events.at(-1)).toMatchObject({ type: "done", model: "anthropic.claude-sonnet-5", fallbackReason: null });
    expect(r.usage.estimatedUsd).toBeGreaterThan(0);
  });

  it("a stale pin holding the bare id resolves to the conversation's own model and is dropped", async () => {
    const c = collect();
    const stale = conv({ modelAlias: "sonnet", pinnedModel: "claude-sonnet-5", pinReason: "refusal", pinnedUntil: null });
    const r = await mk({ provider: bareIdProvider() }).runTurn({ conversation: stale, history, userText: "hola", systemPrompt: "s", emit: c.emit });
    expect(c.events[0]).toEqual({ type: "message_start", model: "anthropic.claude-sonnet-5" });
    expect(r.servedModel).toBe("anthropic.claude-sonnet-5");
    expect(r.pin).toBeNull();
  });
});
