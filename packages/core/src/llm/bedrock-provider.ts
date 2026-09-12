import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { betaRefusalFallbackMiddleware, BetaFallbackState } from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Catalog } from "../catalog.js";
import type { SafeLogger } from "../logger.js";
import { noopLogger } from "../logger.js";
import type { LlmProvider, StreamHandle, StreamParams } from "./provider.js";

export interface BedrockProviderOptions {
  awsRegion: string;
  catalog: Catalog;
  timeoutMs?: number;
  maxRetries?: number;
  logger?: SafeLogger;
}

/**
 * Amazon Bedrock (endpoint Mantle, forma de Messages API). Un cliente por modelo del catálogo:
 * el middleware de refusal-fallback lleva la cadena de ese modelo (p. ej. Fable → Opus 5) y envía
 * por defecto la cabecera beta `fallback-credit-2026-07-01`, disponible en Bedrock.
 */
export class BedrockProvider implements LlmProvider {
  private clients = new Map<string, AnthropicBedrockMantle>();
  private readonly log: SafeLogger;

  constructor(private readonly opts: BedrockProviderOptions) {
    this.log = opts.logger ?? noopLogger;
  }

  private clientFor(modelId: string): AnthropicBedrockMantle {
    const existing = this.clients.get(modelId);
    if (existing) return existing;
    const entry = this.opts.catalog.models.find((m) => m.modelId === modelId);
    const fallbacks = (entry?.refusalFallbacks ?? []).filter((id) => id !== modelId).map((model) => ({ model }));
    const client = new AnthropicBedrockMantle({
      awsRegion: this.opts.awsRegion,
      timeout: this.opts.timeoutMs ?? 600_000,
      maxRetries: this.opts.maxRetries ?? 1,
      middleware: fallbacks.length
        ? [betaRefusalFallbackMiddleware(fallbacks, {
            onError: (e) => this.log.warn("refusal_fallback_error", { model: modelId, reason: e.kind, status: "status" in e ? e.status : null }),
          })]
        : [],
    });
    this.clients.set(modelId, client);
    return client;
  }

  stream(params: StreamParams, opts: { signal: AbortSignal; conversationId: string }): StreamHandle {
    const client = this.clientFor(params.model);
    const body: MessageCreateParamsStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      stream: true,
      output_config: { effort: params.effort },
      system: params.system,
      messages: params.messages,
      ...(params.thinking ? { thinking: params.thinking } : {}),
      // Sin temperature/top_p/top_k, sin prefill, sin tool_choice forzado: 400 en Fable 5.1 / Opus 5.
    };
    // Un BetaFallbackState por request: la fijación durable vive en la conversación (pinnedModel).
    const fallbackState = new BetaFallbackState();
    const s = client.beta.messages.stream(body, { fallbackState, signal: opts.signal });
    return {
      [Symbol.asyncIterator]: () => s[Symbol.asyncIterator](),
      finalMessage: () => s.finalMessage(),
      abort: () => s.abort(),
    };
  }
}
