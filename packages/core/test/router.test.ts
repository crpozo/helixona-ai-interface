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
  it("says when it is waiting for the model and when the model has started, and waits longer for a large request", async () => {
    const c = collect();
    const inner = new FakeProvider({ refusalFallbacks, delayMs: 0 });
    // The first event takes 30 ms to arrive, like a large request being read.
    const slow: LlmProvider = {
      stream: (p, o) => {
        const h = inner.stream(p, o);
        const handle: StreamHandle = {
          async *[Symbol.asyncIterator]() {
            await new Promise((r) => setTimeout(r, 30));
            if (o.signal.aborted) throw new Error("aborted before the first event");
            yield* h;
          },
          finalMessage: () => h.finalMessage(),
          abort: () => h.abort(),
        };
        return handle;
      },
    };
    // 400k tokens at 1 ms per thousand: 400 ms on top of a 10 ms base, enough for a first event that takes 30 ms.
    const r = await new ModelRouter({ catalog: DEFAULT_CATALOG, provider: slow, firstEventTimeoutMs: 10, firstEventMsPerThousandTokens: 1 }).runTurn({ conversation: conv(), history, userText: "hola", systemPrompt: "s", emit: c.emit, estimatedInputTokens: 400_000 });
    expect(r.ok).toBe(true);
    const statuses = c.events.filter((e) => e.type === "status");
    expect(statuses).toEqual([
      { type: "status", stage: "waiting", model: "anthropic.claude-fable-5-1", inputTokens: 400_000 },
      { type: "status", stage: "responding", model: "anthropic.claude-fable-5-1", inputTokens: 400_000 },
    ]);
    expect(c.events[1]).toEqual(statuses[0]);
    // Without the allowance the same request gives up at 10 ms and tries the next model.
    const c2 = collect();
    await new ModelRouter({ catalog: DEFAULT_CATALOG, provider: slow, firstEventTimeoutMs: 10, firstEventMsPerThousandTokens: 0 }).runTurn({ conversation: conv(), history, userText: "hola", systemPrompt: "s", emit: c2.emit, estimatedInputTokens: 400_000 });
    expect(c2.events.some((e) => e.type === "model_switched")).toBe(true);
    expect(c2.events.filter((e) => e.type === "status" && e.stage === "responding")).toHaveLength(0);
  });

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

  it("sonnet: a classifier refusal on Sonnet 5.5 falls back to Sonnet 5 and pins it; a refusal by both is reported", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv({ modelAlias: "sonnet" }), history, userText: "/refuse x", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(true);
    expect(r.servedModel).toBe("anthropic.claude-sonnet-5");
    expect(r.fallbackReason).toBe("refusal");
    expect(r.pin).toEqual({ model: "anthropic.claude-sonnet-5", reason: "refusal", until: null });
    const d = collect();
    const all = await mk().runTurn({ conversation: conv({ modelAlias: "sonnet" }), history, userText: "/refuse-all x", systemPrompt: "s", emit: d.emit });
    expect(all.ok).toBe(false);
    expect(d.events.at(-1)?.type).toBe("refused");
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

  it("sonnet: Sonnet 5.5 busy before any output → Sonnet 5 answers, with a soft pin", async () => {
    const c = collect();
    const r = await mk().runTurn({ conversation: conv({ modelAlias: "sonnet" }), history, userText: "/throttle x", systemPrompt: "s", emit: c.emit });
    expect(r.ok).toBe(true);
    expect(r.servedModel).toBe("anthropic.claude-sonnet-5");
    expect(r.fallbackReason).toBe("availability");
    expect(r.pin?.reason).toBe("availability");
    expect(c.events).toContainEqual({ type: "model_switched", from: "anthropic.claude-sonnet-5-5", to: "anthropic.claude-sonnet-5", reason: "availability" });
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

/** Provider that reports the Anthropic API's bare ids (`claude-sonnet-5-5`) instead of the catalog's `anthropic.` ids. */
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
    expect(r.servedModel).toBe("anthropic.claude-sonnet-5-5");
    expect(r.fallbackReason).toBeNull();
    expect(r.pin).toBeNull();
    expect(c.events.some((e) => e.type === "fallback")).toBe(false);
    expect(c.events.at(-1)).toMatchObject({ type: "done", model: "anthropic.claude-sonnet-5-5", fallbackReason: null });
    expect(r.usage.estimatedUsd).toBeGreaterThan(0);
  });

  it("a stale pin holding the bare id resolves to the conversation's own model and is dropped", async () => {
    const c = collect();
    const stale = conv({ modelAlias: "sonnet", pinnedModel: "claude-sonnet-5-5", pinReason: "refusal", pinnedUntil: null });
    const r = await mk({ provider: bareIdProvider() }).runTurn({ conversation: stale, history, userText: "hola", systemPrompt: "s", emit: c.emit });
    expect(c.events[0]).toEqual({ type: "message_start", model: "anthropic.claude-sonnet-5-5" });
    expect(r.servedModel).toBe("anthropic.claude-sonnet-5-5");
    expect(r.pin).toBeNull();
  });
});

describe("ModelRouter with tools", () => {
  const zipDoc = { type: "document", title: "EOBs.zip", source: { type: "text", media_type: "text/plain", data: 'ZIP "EOBs.zip": 2 files.\nFiles (path · size):\nChecks.csv · 45 B\nnotes.docx · 2 B (not readable)' } } as never;
  const definitions = [{ name: "read_zip_files", description: "reads", input_schema: { type: "object" as const, properties: {}, required: [] } }];
  const tools = (execute: (call: { name: string; input: unknown }, signal: AbortSignal) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; summary: string }>, maxRounds?: number) => ({
    definitions,
    execute,
    describe: (c: { name: string }) => `Reading files (${c.name})`,
    ...(maxRounds ? { maxRounds } : {}),
  });

  it("runs the tool the model asks for, shows it as a step, and feeds the result back to the same model", async () => {
    const c = collect();
    const calls: unknown[] = [];
    const r = await mk().runTurn({
      conversation: conv(),
      history,
      userText: "What is in the checks file?",
      userContent: [zipDoc, { type: "text", text: "What is in the checks file?" }],
      systemPrompt: "s",
      emit: c.emit,
      tools: tools(async (call) => {
        calls.push(call.input);
        return { content: [{ type: "text", text: "=== EOBs.zip › Checks.csv ===\nRow,Patient,Amount\n2,Ana,$10.00" }], summary: "Read 1 file from EOBs.zip: Checks.csv" };
      }),
    });
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ attachment: "EOBs.zip", paths: ["Checks.csv"] }]);
    // The remark before the call became a note; the call ran as a step; the answer quotes what was read.
    const types = c.events.map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["message_start", "status", "status"]);
    expect(c.events.find((e) => e.type === "round")).toEqual({ type: "round", round: 1, note: "Let me read the files first." });
    const steps = c.events.filter((e) => e.type === "step").map((e) => (e as { steps: Array<{ text: string; state: string }> }).steps[0]!);
    expect(steps).toEqual([{ id: expect.any(String), text: "Reading files (read_zip_files)", state: "running" }, { id: expect.any(String), text: "Read 1 file from EOBs.zip: Checks.csv", state: "done" }]);
    expect(c.text()).toContain("Let me read the files first.");
    expect(c.text()).toContain("Read from the ZIP:");
    expect(c.text()).toContain("Ana,$10.00");
    // Stored: the final round as the content, the earlier round replayable, the activity list.
    expect(r.content.map((b) => b.type)).toEqual(["text"]);
    expect((r.content[0] as { text: string }).text).toContain("Read from the ZIP");
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0]!.assistant.map((b) => b.type)).toEqual(["text", "tool_use"]);
    expect(r.rounds[0]!.results[0]).toMatchObject({ type: "tool_result", tool_use_id: (r.rounds[0]!.assistant[1] as { id: string }).id });
    expect(r.steps.map((s) => s.text)).toEqual(["Let me read the files first.", "Read 1 file from EOBs.zip: Checks.csv"]);
    // Both rounds are paid for; the conversation's size is the last round's.
    expect(r.usage.outputTokens).toBeGreaterThan(20);
    expect(r.contextTokens).toBeLessThan(r.usage.inputTokens + r.usage.cacheReadTokens + r.usage.outputTokens);
    expect(c.events.at(-1)!.type).toBe("done");
  });

  it("a tool that fails answers the model with an error result, and the turn goes on", async () => {
    const c = collect();
    const r = await mk().runTurn({
      conversation: conv(),
      history,
      userText: "q",
      userContent: [zipDoc, { type: "text", text: "q" }],
      systemPrompt: "s",
      emit: c.emit,
      tools: tools(async () => { throw new Error("boom"); }),
    });
    expect(r.ok).toBe(true);
    expect(r.rounds[0]!.results[0]).toMatchObject({ is_error: true });
    expect(c.text()).toContain("The tool failed");
    expect(r.steps.at(-1)!.text).toBe("Reading files (read_zip_files): failed");
  });

  it("at the round cap the model's pending tool call is dropped so the stored turn stays valid", async () => {
    const c = collect();
    const r = await mk().runTurn({
      conversation: conv(),
      history,
      userText: "q",
      userContent: [zipDoc, { type: "text", text: "q" }],
      systemPrompt: "s",
      emit: c.emit,
      tools: tools(async () => ({ content: [{ type: "text", text: "x" }], summary: "x" }), 1),
    });
    expect(r.ok).toBe(true);
    expect(r.rounds).toHaveLength(0);
    expect(r.content.map((b) => b.type)).toEqual(["text"]);
    expect(c.events.some((e) => e.type === "round")).toBe(false);
  });

  it("Stop while a tool runs ends the turn as canceled", async () => {
    const c = collect();
    const ac = new AbortController();
    const r = await mk().runTurn({
      conversation: conv(),
      history,
      userText: "q",
      userContent: [zipDoc, { type: "text", text: "q" }],
      systemPrompt: "s",
      emit: c.emit,
      signal: ac.signal,
      // The person presses Stop while the tool runs; the tool itself never settles.
      tools: tools(() => new Promise(() => { ac.abort(); })),
    });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe("aborted");
    expect(c.events.at(-1)).toMatchObject({ type: "error", code: "aborted" });
  });
});
