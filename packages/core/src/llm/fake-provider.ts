import { InternalServerError, RateLimitError } from "@anthropic-ai/sdk";
import type { BetaMessage, BetaRawMessageStreamEvent, BetaContentBlock, BetaTextBlock } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { LlmProvider, StreamHandle, StreamParams } from "./provider.js";

/**
 * Proveedor falso para desarrollo local y pruebas, sin Bedrock. Interpreta órdenes en el último
 * mensaje de usuario para simular comportamientos:
 *   /refuse         → Fable rechaza; el "middleware" cae al primer respaldo y continúa (bloque fallback).
 *   /refuse-mid     → rechazo a mitad de salida: texto parcial + bloque fallback + continuación.
 *   /refuse-all     → toda la cadena rechaza (stop_reason refusal, categoría bio).
 *   /throttle       → RateLimitError antes de emitir nada.
 *   /throttle-mid   → InternalServerError después de emitir texto.
 *   /hang           → nunca emite el primer evento (para probar el timeout).
 *   /long           → stop_reason max_tokens.
 *   /doc, /doc-pdf, /doc-csv, /doc-txt → the reply is a document (a ```document fence), like a real
 *                     request for a Word file, a PDF or a spreadsheet would get.
 */
export interface FakeProviderOptions { refusalFallbacks?: Record<string, string[]>; delayMs?: number; sleep?: (ms: number) => Promise<void> }

export class FakeProvider implements LlmProvider {
  private attempts = new Map<string, number>();
  constructor(private readonly opts: FakeProviderOptions = {}) {}

  stream(params: StreamParams, opts: { signal: AbortSignal; conversationId?: string }): StreamHandle {
    const last = params.messages[params.messages.length - 1];
    const userText = extractText(last?.content);
    let cmd = (userText.match(/^\/(refuse-all|refuse-mid|refuse|throttle-mid|throttle|hang|long)\b/)?.[1]) ?? null;
    // Las órdenes de indisponibilidad (/throttle, /hang) solo aplican al primer intento del turno,
    // para que el reintento en el modelo de respaldo tenga éxito.
    const key = `${opts.conversationId ?? "-"}|${params.messages.length}|${userText.slice(0, 40)}`;
    const n = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, n);
    if ((cmd === "throttle" || cmd === "hang") && n > 1) cmd = null;
    const fallback = this.opts.refusalFallbacks?.[params.model]?.[0] ?? null;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const delay = this.opts.delayMs ?? 5;
    const self = this;
    let final: BetaMessage | null = null;
    let finalResolve!: (m: BetaMessage) => void;
    let finalReject!: (e: unknown) => void;
    const finalPromise = new Promise<BetaMessage>((res, rej) => { finalResolve = res; finalReject = rej; });
    finalPromise.catch(() => {});

    async function* gen(): AsyncGenerator<BetaRawMessageStreamEvent> {
      try {
        if (cmd === "hang") { await new Promise<void>((_r, rej) => opts.signal.addEventListener("abort", () => rej(abortError()))); return; }
        if (cmd === "throttle") throw new RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "Too many requests" } }, "Too many requests", new Headers());

        let model = params.model;
        const content: BetaContentBlock[] = [];
        const preRefusal = cmd === "refuse" && fallback;
        if (preRefusal) {
          // Rechazo antes de cualquier salida: el middleware cambia de modelo de forma transparente.
          model = fallback!;
          content.push({ type: "fallback", from: { model: params.model }, to: { model } } as unknown as BetaContentBlock);
        }
        yield { type: "message_start", message: msg(model, []) } as BetaRawMessageStreamEvent;
        if (preRefusal) {
          yield { type: "content_block_start", index: 0, content_block: content[0]! } as BetaRawMessageStreamEvent;
          yield { type: "content_block_stop", index: 0 } as BetaRawMessageStreamEvent;
        }
        if (cmd === "refuse-all" || (cmd === "refuse" && !fallback)) {
          yield { type: "message_delta", delta: { stop_reason: "refusal", stop_sequence: null, container: null, stop_details: { type: "refusal", category: "bio", explanation: null, fallback_credit_token: null, fallback_has_prefill_claim: null, recommended_model: null } }, usage: usage(0, 0), context_management: null } as unknown as BetaRawMessageStreamEvent;
          yield { type: "message_stop" } as BetaRawMessageStreamEvent;
          final = { ...msg(model, []), stop_reason: "refusal", stop_details: { type: "refusal", category: "bio", explanation: null, fallback_credit_token: null, fallback_has_prefill_claim: null, recommended_model: null } };
          finalResolve(final);
          return;
        }
        const reply = self.replyFor(userText, model);
        const parts = reply.match(/.{1,12}/gs) ?? [];
        let idx = content.length;
        let text = "";
        yield { type: "content_block_start", index: idx, content_block: { type: "text", text: "", citations: null } } as BetaRawMessageStreamEvent;
        let switched = false;
        for (let i = 0; i < parts.length; i++) {
          if (opts.signal.aborted) throw abortError();
          if (cmd === "throttle-mid" && i === 2) throw new InternalServerError(503, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "Overloaded", new Headers());
          if (cmd === "refuse-mid" && fallback && i === 2 && !switched) {
            switched = true;
            yield { type: "content_block_stop", index: idx } as BetaRawMessageStreamEvent;
            content.push({ type: "text", text, citations: null } as BetaTextBlock);
            idx++;
            const fb = { type: "fallback", from: { model }, to: { model: fallback } } as unknown as BetaContentBlock;
            content.push(fb);
            yield { type: "content_block_start", index: idx, content_block: fb } as BetaRawMessageStreamEvent;
            yield { type: "content_block_stop", index: idx } as BetaRawMessageStreamEvent;
            model = fallback;
            idx++; text = "";
            yield { type: "content_block_start", index: idx, content_block: { type: "text", text: "", citations: null } } as BetaRawMessageStreamEvent;
          }
          await sleep(delay);
          text += parts[i]!;
          yield { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: parts[i]! } } as BetaRawMessageStreamEvent;
        }
        yield { type: "content_block_stop", index: idx } as BetaRawMessageStreamEvent;
        content.push({ type: "text", text, citations: null } as BetaTextBlock);
        const stop = cmd === "long" ? "max_tokens" : "end_turn";
        const inTok = Math.ceil(JSON.stringify(params.messages).length / 4);
        const u = usage(inTok, Math.ceil(reply.length / 4));
        yield { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null, container: null, stop_details: null }, usage: u, context_management: null } as unknown as BetaRawMessageStreamEvent;
        yield { type: "message_stop" } as BetaRawMessageStreamEvent;
        final = { ...msg(model, content), stop_reason: stop, usage: { ...msg(model, content).usage, ...u, iterations: switched || preRefusal ? [{ type: "fallback_message", model } as never] : null } };
        finalResolve(final);
      } catch (e) {
        finalReject(e);
        throw e;
      }
    }
    const it = gen();
    return {
      [Symbol.asyncIterator]: () => it,
      finalMessage: () => finalPromise,
      abort: () => { void it.return(undefined as never); },
    };
  }

  private replyFor(userText: string, model: string): string {
    const clean = userText.replace(/^\/\S+\s*/, "");
    const asked = userText.match(/^\/doc(?:-(pdf|csv|txt))?\b/);
    const natural = /^(?:dame|give me|generate|make|create|hazme|genera)\b.*\b(?:word|pdf|excel|csv|document|documento)\b/i.test(userText);
    if (asked || natural) {
      const kind = asked ? (asked[1] ?? "word") : /\bpdf\b/i.test(userText) ? "pdf" : /\b(?:excel|csv)\b/i.test(userText) ? "csv" : "word";
      const lang = kind === "word" ? "document" : `document-${kind}`;
      const title = (clean || "Summary").slice(0, 60);
      return `Here is the document.\n\n\`\`\`${lang}\n# ${title}\n\nPrepared by the Helixona Assistant for review.\n\n## Findings\n\n- First finding\n- Second finding\n\n| Item | Value |\n| --- | --- |\n| Sample | 12.3 |\n\`\`\`\n\nReview the names and dates before sending.`;
    }
    return `**Simulated reply** (${model}).\n\nReceived: "${clean.slice(0, 120)}".\n\n- This is a fake provider for development.\n- There is no connection to Bedrock.\n\nSee the [documentation](https://example.com/doc) for more details.`;
  }
}

function abortError(): Error { const e = new Error("aborted"); e.name = "AbortError"; return e; }

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.type === "text" ? String(b.text ?? "") : "")).join("");
  return "";
}

function usage(input: number, output: number) {
  return { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: Math.floor(input / 2), server_tool_use: null, service_tier: null, cache_creation: null, fallback_credit: null, inference_geo: null, iterations: null, output_tokens_details: null, speed: null };
}

function msg(model: string, content: BetaContentBlock[]): BetaMessage {
  return {
    id: "msg_fake", type: "message", role: "assistant", model, content,
    stop_reason: null, stop_sequence: null, container: null, context_management: null, stop_details: null,
    usage: usage(0, 0),
  } as unknown as BetaMessage;
}
