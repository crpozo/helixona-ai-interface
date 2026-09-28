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

/** Lets the request carry `thinking.block_binding`, and adds `input_transformations` to responses. */
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/**
 * The request body. Thinking blocks are passed back unchanged, but the history is not strictly
 * append-only (a new system prompt after a release, edited project instructions or files, a file
 * that is now read page by page instead of sent whole), and newer accounts get a 400 when a thinking
 * block no longer matches the conversation before it. "drop_block" tells the API to drop those
 * blocks and answer without that earlier reasoning. Every model in the catalog accepts it, so the
 * fallback middleware can re-send the same body.
 */
export function buildRequestBody(mode: SdkProviderMode, params: StreamParams): MessageCreateParamsStreaming {
  const thinking = params.thinking && params.thinking.type !== "adaptive" ? params.thinking : { ...(params.thinking ?? { type: "adaptive" as const }), block_binding: { prefix_mismatch_behavior: "drop_block" as const } };
  return {
    model: toProviderModelId(mode, params.model),
    max_tokens: params.maxTokens,
    stream: true,
    output_config: { effort: params.effort },
    system: params.system,
    messages: params.messages,
    thinking,
    betas: [THINKING_BINDING_BETA],
    // No temperature/top_p/top_k, no prefill, no forced tool_choice: 400 on the current models.
  };
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
    const body = buildRequestBody(this.opts.mode, params);
    const fallbackState = new BetaFallbackState(); // uno por request; el pin durable vive en la conversación
    const s = client.beta.messages.stream(body, { fallbackState, signal: opts.signal });
    return {
      [Symbol.asyncIterator]: () => s[Symbol.asyncIterator](),
      finalMessage: () => s.finalMessage(),
      abort: () => s.abort(),
    };
  }
}
