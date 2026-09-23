// Tipos copiados de docs/CONTRATO.md. Si el contrato cambia, cambia aquí.

export type Role = "staff" | "admin";

export type ModelAlias = "sonnet" | "opus" | "fable" | (string & {});

export interface CatalogModel {
  alias: string;
  modelId: string;
  label: string;
  description: string;
  costFactor: number;
  available: boolean;
}

export interface Me {
  user: { id: string; email: string; name: string; roles: Role[] };
  session: { expiresAt: string; idleTimeoutSeconds: number };
  /** Workforce training: when `required` and not `complete`, the assistant is locked (administrators included). */
  training?: { required: boolean; complete: boolean; canSkip?: boolean; version: string };
  catalog: {
    defaultAlias: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
    models: CatalogModel[];
  };
  limits: { maxMessageChars: number; contextLimitTokens: number; attachments?: AttachmentLimits };
}

export type FallbackReason = "refusal" | "availability";

export interface Conversation {
  id: string;
  title: string;
  modelAlias: string;
  modelId: string;
  pinnedModel: string | null;
  pinReason: FallbackReason | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  projectId?: string | null;
}

export type ProjectVisibility = "private" | "clinic";

/** A project: instructions plus knowledge files shared by every conversation inside it. */
export interface Project {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  instructions: string;
  visibility: ProjectVisibility;
  knowledge: AttachmentMeta[];
  createdAt: string;
  updatedAt: string;
  canEdit: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
}

/** Bloques de contenido tal cual la API. Solo interpretamos `text` y `thinking`. */
export interface TextBlock {
  type: "text";
  text: string;
}
export interface ThinkingBlock {
  type: "thinking";
  thinking?: string;
  text?: string;
}
export interface OtherBlock {
  type: string;
  [key: string]: unknown;
}
export type ContentBlock = TextBlock | ThinkingBlock | OtherBlock;

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  model: string | null;
  fallbackReason: FallbackReason | null;
  stopReason: string | null;
  usage: Usage | null;
  createdAt: string;
  attachments?: AttachmentMeta[];
}

/** A file attached to a user turn (metadata only; bytes stay in the clinic's storage). */
export interface AttachmentMeta {
  id: string;
  name: string;
  contentType: string;
  size: number;
  pages: number | null;
}

export interface AttachmentLimits {
  enabled: boolean;
  maxMb: number;
  maxPerMessage: number;
  accept: string[];
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  enabled: boolean;
  createdAt: string;
  /** `invited`: still on the temporary password from the invitation email (first sign-in pending). */
  status?: "invited" | "active";
}

export interface AuditEvent {
  id: string;
  ts: string;
  userId: string;
  action: string;
  conversationId?: string;
  model?: string;
  servedBy?: string;
  fallbackReason?: string;
  refusalCategory?: string | null;
  stopReason?: string;
  usage?: Usage;
  latencyMs?: number;
  meta?: Record<string, string | number | boolean>;
}

export interface UsageRow {
  userId: string;
  day: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  byModel: Record<string, { turns: number; estimatedUsd: number }>;
}

export interface TrainingRecord {
  userId: string;
  name: string;
  email: string;
  version: string;
  attempts: number;
  lastScore: number;
  lastAttemptAt: string;
  bestScore: number;
  passedAt: string | null;
  source?: "online" | "paper" | "attested";
  recordedBy?: string;
  recordedAt?: string;
  moduleProgress?: Record<string, TrainingModuleProgress>;
}

export interface TrainingQuestion {
  n: number;
  module: number;
  text: string;
  options: { letter: string; text: string }[];
}

export interface TrainingModule {
  id: number;
  title: string;
  questions: number[];
}

export interface TrainingModuleProgress {
  attempts: number;
  firstTryCorrect: number;
  total: number;
  completedAt: string | null;
}

export interface TrainingInfo {
  version: string;
  passingScore: number;
  total: number;
  questions: TrainingQuestion[];
  modules: TrainingModule[];
  record: TrainingRecord | null;
}

export interface TrainingModuleResult {
  results: { n: number; correct: boolean; why?: string }[];
  correct: number;
  total: number;
  moduleComplete: boolean;
  courseComplete: boolean;
}

export interface TrainingCheckResult {
  score: number;
  total: number;
  passed: boolean;
  results: { n: number; correct: boolean; why?: string }[];
}

export interface AdminTrainingRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  enabled: boolean;
  /** False for a record whose user is no longer in the directory. */
  inDirectory: boolean;
  record: TrainingRecord | null;
}

export interface AdminTrainingLog {
  items: AdminTrainingRow[];
  version: string;
  passingScore: number;
  total: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

// ---- Eventos SSE (§4) ----

export type SseErrorCode =
  | "quota_exceeded"
  | "context_limit"
  | "model_unavailable"
  | "bad_request"
  | "internal"
  | (string & {});

export interface SseMessageStart {
  userMessageId: string;
  assistantMessageId: string;
  model: string;
}
export interface SseTextDelta {
  text: string;
}
export interface SseFallback {
  from: string;
  to: string;
  reason: "refusal";
}
export interface SseModelSwitched {
  from: string;
  to: string;
  reason: "availability";
}
export interface SseRefused {
  category: string | null;
}
export interface SseError {
  code: SseErrorCode;
  message: string;
  retryable: boolean;
  partial: boolean;
}
export interface SseDone {
  assistantMessageId: string;
  model: string;
  stopReason: string | null;
  usage: Usage | null;
  fallbackReason: FallbackReason | null;
}

export type ChatSseEvent =
  | { type: "message_start"; data: SseMessageStart }
  | { type: "text_delta"; data: SseTextDelta }
  | { type: "thinking_delta"; data: SseTextDelta }
  | { type: "fallback"; data: SseFallback }
  | { type: "model_switched"; data: SseModelSwitched }
  | { type: "refused"; data: SseRefused }
  | { type: "error"; data: SseError }
  | { type: "done"; data: SseDone };

// ---- Business associate agreements ----
export interface AgreementFile {
  size: number;
  uploadedAt: string | null;
  /** The clinic's uploaded copy, or the vendor's document bundled with the app. */
  source: "uploaded" | "bundled";
}
export interface Agreement {
  id: string;
  vendor: string;
  title: string;
  since: string;
  status: string;
  reference: string;
  url: string;
  note: string;
  /** The clinic's PDF copy on file; null when none, or for visitors. */
  file: AgreementFile | null;
}
export interface AgreementsInfo { items: Agreement[]; canDownload: boolean; uploads: boolean }

// ---- Bug report delivery (administration) ----
export interface FeedbackStatus {
  enabled: boolean;
  email: string | null;
  subscription: "confirmed" | "pending" | "none" | "unknown";
}
