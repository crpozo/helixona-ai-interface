import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

export type Role = "staff" | "admin";
export type PinReason = "refusal" | "availability";

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  modelAlias: string;
  modelId: string;
  pinnedModel: string | null;
  pinReason: PinReason | null;
  pinnedUntil: string | null;
  systemPromptVersion: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  /** input_tokens del último turno: medida autoritativa del tamaño del contexto. */
  lastInputTokens: number;
}

export interface UsageSummary { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedUsd: number }

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: "user" | "assistant";
  content: BetaContentBlock[] | BetaContentBlockParam[];
  model: string | null;
  fallbackReason: PinReason | null;
  stopReason: string | null;
  usage: UsageSummary | null;
  createdAt: string;
}

export type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam };

/** Eventos normalizados del turno (mapeo 1:1 con los eventos SSE del contrato). */
export type TurnEvent =
  | { type: "message_start"; model: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "fallback"; from: string; to: string; reason: "refusal" }
  | { type: "model_switched"; from: string; to: string; reason: "availability" }
  | { type: "refused"; category: string | null }
  | { type: "error"; code: "model_unavailable" | "bad_request" | "internal" | "aborted"; message: string; retryable: boolean; partial: boolean }
  | { type: "done"; model: string; stopReason: string | null; usage: UsageSummary; fallbackReason: PinReason | null };
