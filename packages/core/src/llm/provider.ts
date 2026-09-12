import type { BetaMessage, BetaRawMessageStreamEvent, BetaMessageParam, BetaTextBlockParam, BetaThinkingConfigParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { Effort } from "../catalog.js";

export interface StreamParams {
  model: string;
  maxTokens: number;
  effort: Effort;
  system: BetaTextBlockParam[];
  messages: BetaMessageParam[];
  thinking?: BetaThinkingConfigParam;
}

export interface StreamHandle extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>;
  abort(): void;
}

/**
 * Proveedor de inferencia. Cada modelo tiene su propio cliente (con su cadena de refusal-fallback),
 * porque el middleware se configura a nivel de cliente y el modelo de respaldo nunca puede ser
 * el mismo que el solicitado.
 */
export interface LlmProvider {
  stream(params: StreamParams, opts: { signal: AbortSignal; conversationId: string }): StreamHandle;
}
