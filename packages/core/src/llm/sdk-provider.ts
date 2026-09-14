import Anthropic, { betaRefusalFallbackMiddleware, BetaFallbackState, type Middleware } from "@anthropic-ai/sdk";
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { AnthropicAws } from "@anthropic-ai/aws-sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Catalog } from "../catalog.js";
import { noopLogger, type SafeLogger } from "../logger.js";
import type { LlmProvider, StreamHandle, StreamParams } from "./provider.js";

/**
 * Tres formas de llegar a los mismos modelos con la misma forma de Messages API:
 *  - bedrock:             Amazon Bedrock, endpoint Mantle. IDs con prefijo `anthropic.`. Auth SigV4 (rol de la tarea).
 *  - anthropic:           Claude API de Anthropic. IDs sin prefijo. Auth por API key (secreto). Requiere BAA de Anthropic para PHI.
 *  - claude-platform-aws: Claude Platform on AWS (operado por Anthropic, facturación AWS Marketplace). IDs sin prefijo.
 *                         Auth SigV4 + ANTHROPIC_AWS_WORKSPACE_ID. Cobertura HIPAA/BAA a confirmar con Anthropic.
 * El catálogo se escribe siempre con IDs de Bedrock (`anthropic.claude-opus-5`); aquí se traducen.
 */
export type SdkProviderMode = "bedrock" | "anthropic" | "claude-platform-aws";

export interface SdkProviderOptions {
  mode: SdkProviderMode;
  catalog: Catalog;
  awsRegion?: string;
  apiKey?: string;
  workspaceId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  logger?: SafeLogger;
}

type MessagesClient = Anthropic | AnthropicBedrockMantle | AnthropicAws;

export function toProviderModelId(mode: SdkProviderMode, catalogModelId: string): string {
  return mode === "bedrock" ? catalogModelId : catalogModelId.replace(/^anthropic\./, "");
}

export class SdkProvider implements LlmProvider {
  private clients = new Map<string, MessagesClient>();
  private readonly log: SafeLogger;

  constructor(private readonly opts: SdkProviderOptions) {
    this.log = opts.logger ?? noopLogger;
    if (opts.mode === "bedrock" && !opts.awsRegion) throw new Error("bedrock: falta awsRegion");
    if (opts.mode === "anthropic" && !opts.apiKey) throw new Error("anthropic: falta apiKey");
    if (opts.mode === "claude-platform-aws" && (!opts.awsRegion || !opts.workspaceId)) throw new Error("claude-platform-aws: faltan awsRegion o workspaceId");
  }

  get mode(): SdkProviderMode { return this.opts.mode; }

  private middlewareFor(catalogModelId: string): Middleware[] {
    const entry = this.opts.catalog.models.find((m) => m.modelId === catalogModelId);
    const fallbacks = (entry?.refusalFallbacks ?? []).filter((id) => id !== catalogModelId).map((id) => ({ model: toProviderModelId(this.opts.mode, id) }));
    if (!fallbacks.length) return [];
    // El middleware del SDK reintenta los rechazos del clasificador en la cadena de respaldo y envía por defecto
    // la cabecera beta fallback-credit; funciona igual en las tres plataformas.
    return [betaRefusalFallbackMiddleware(fallbacks, {
      onError: (e) => this.log.warn("refusal_fallback_error", { model: catalogModelId, reason: e.kind, status: "status" in e ? e.status : null }),
    })];
  }

  private clientFor(catalogModelId: string): MessagesClient {
    const existing = this.clients.get(catalogModelId);
    if (existing) return existing;
    const common = { timeout: this.opts.timeoutMs ?? 600_000, maxRetries: this.opts.maxRetries ?? 1, middleware: this.middlewareFor(catalogModelId) };
    let client: MessagesClient;
    switch (this.opts.mode) {
      case "bedrock": client = new AnthropicBedrockMantle({ awsRegion: this.opts.awsRegion, ...common }); break;
      case "anthropic": client = new Anthropic({ apiKey: this.opts.apiKey, ...common }); break;
      case "claude-platform-aws": client = new AnthropicAws({ awsRegion: this.opts.awsRegion, workspaceId: this.opts.workspaceId, ...common }); break;
    }
    this.clients.set(catalogModelId, client);
    return client;
  }

  stream(params: StreamParams, opts: { signal: AbortSignal; conversationId: string }): StreamHandle {
    const client = this.clientFor(params.model);
    const body: MessageCreateParamsStreaming = {
      model: toProviderModelId(this.opts.mode, params.model),
      max_tokens: params.maxTokens,
      stream: true,
      output_config: { effort: params.effort },
      system: params.system,
      messages: params.messages,
      ...(params.thinking ? { thinking: params.thinking } : {}),
      // Sin temperature/top_p/top_k, sin prefill, sin tool_choice forzado: 400 en Fable 5.1 / Opus 5.
    };
    const fallbackState = new BetaFallbackState(); // uno por request; el pin durable vive en la conversación
    const s = client.beta.messages.stream(body, { fallbackState, signal: opts.signal });
    return {
      [Symbol.asyncIterator]: () => s[Symbol.asyncIterator](),
      finalMessage: () => s.finalMessage(),
      abort: () => s.abort(),
    };
  }
}
