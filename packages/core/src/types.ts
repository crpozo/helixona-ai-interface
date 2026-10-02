import type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

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
  /** Project this conversation belongs to (its instructions and knowledge are injected on every turn). */
  projectId?: string | null;
  /** Who started it. In a shared project the conversation is stored under the project, not under a person. */
  createdBy?: string;
  createdByName?: string;
  /** Set while a turn is running: nobody else can send in this conversation until then. */
  busyUntil?: string | null;
  /** Id of the chat in the system it was imported from (a Claude.ai export), so a second import skips it. */
  importedFrom?: string;
  /** Kept as an archive: exempt from the retention period (an imported backup); deleted only by hand. */
  archived?: boolean;
}

/**
 * `private`: the owner's alone. `shared`: the owner plus chosen members, who all see and continue
 * the same conversations. `clinic`: everyone may use its instructions and files; chats stay personal.
 */
export type ProjectVisibility = "private" | "shared" | "clinic";

/** Someone a shared project is shared with (name and email as they were in the directory when added). */
export interface ProjectMember {
  id: string;
  name: string;
  email: string;
  addedAt: string;
}

/** A project: shared instructions plus knowledge files that every conversation inside it receives. */
export interface Project {
  id: string;
  ownerId: string;
  /** The owner's name when the project was created (shown in the members list). */
  ownerName?: string;
  name: string;
  description: string;
  instructions: string;
  visibility: ProjectVisibility;
  /** Accounts besides the owner that take part in a `shared` project. */
  members: ProjectMember[];
  knowledge: AttachmentMeta[];
  createdAt: string;
  updatedAt: string;
}

export interface UsageSummary { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedUsd: number }

/** A file attached to a user turn. Bytes live in object storage (never in the database); this is only metadata. */
export interface AttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  /** PDF page count when known (used to estimate tokens and enforce the per-file page limit). */
  pages: number | null;
  /** Object key in the attachments store. */
  key: string;
  /** Characters of the text the model receives when it is not the file itself: a spreadsheet read into rows (cut to fit). */
  modelChars?: number;
  /** A spreadsheet: its data rows and columns, and how many rows the model receives. */
  sheet?: { rows: number; columns: number; shown: number };
  /** A ZIP archive: the files it holds, how many of them the tools can read, and their size unpacked. */
  zip?: { files: number; readable: number; bytes: number };
}

/**
 * One round of an assistant turn that used tools: what the model sent (its tool calls included) and
 * what the tools returned. Replayed exactly on later turns, so the model keeps what it read.
 */
export interface ToolRound {
  assistant: BetaContentBlock[];
  results: BetaToolResultBlockParam[];
}

/** A line of the activity list kept with an answer: what a tool did, or a remark the model made along the way. */
export interface TurnStep {
  text: string;
  ms: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: "user" | "assistant";
  content: BetaContentBlock[] | BetaContentBlockParam[];
  /** Files attached to this (user) turn; the document blocks are rebuilt from storage on every request. */
  attachments?: AttachmentMeta[];
  /** Who wrote a user turn (shown in shared projects, where several people write in one conversation). */
  authorId?: string;
  authorName?: string;
  /** Earlier rounds of this turn (tool calls and their results), loaded from storage when the turn is replayed; `content` is the final round. */
  rounds?: ToolRound[];
  /** A turn that used tools: where its rounds are kept, and the activity list shown with the answer. */
  tools?: { key: string; steps: TurnStep[] };
  model: string | null;
  fallbackReason: PinReason | null;
  stopReason: string | null;
  usage: UsageSummary | null;
  createdAt: string;
}

export type { BetaContentBlock, BetaContentBlockParam, BetaMessageParam, BetaToolResultBlockParam };

/** Eventos normalizados del turno (mapeo 1:1 con los eventos SSE del contrato). */
export type TurnEvent =
  | { type: "message_start"; model: string }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "fallback"; from: string; to: string; reason: "refusal" }
  | { type: "model_switched"; from: string; to: string; reason: "availability" }
  /** Waiting for the model's first event (a large request takes a while), then the model has started. */
  | { type: "status"; stage: "waiting" | "responding"; model: string; inputTokens: number | null }
  /** Activity lines: a tool being used, then done (same shape as the server's own lines). */
  | { type: "step"; steps: Array<{ id: string; text: string; state: "running" | "done" }> }
  /** The model paused to use tools: the text streamed so far in this round was a remark along the way, not the answer. */
  | { type: "round"; round: number; note: string | null }
  | { type: "refused"; category: string | null }
  | { type: "error"; code: "model_unavailable" | "bad_request" | "internal" | "aborted"; message: string; retryable: boolean; partial: boolean }
  | { type: "done"; model: string; stopReason: string | null; usage: UsageSummary; fallbackReason: PinReason | null };
