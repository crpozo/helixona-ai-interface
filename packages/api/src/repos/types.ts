import type { Conversation, PinReason, Role, StoredMessage, UsageSummary } from "@helixona/core";

export interface Session {
  id: string;
  userId: string;
  email: string;
  name: string;
  roles: Role[];
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  expiresAt: number; // epoch s (TTL / inactividad)
  refreshToken: string | null;
}

export interface AuditEvent {
  id: string;
  ts: string;
  day: string;
  userId: string;
  action: string;
  conversationId?: string;
  model?: string;
  servedBy?: string;
  fallbackReason?: string;
  refusalCategory?: string | null;
  stopReason?: string;
  usage?: UsageSummary;
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

export interface ConversationPatch {
  title?: string;
  pinnedModel?: string | null;
  pinReason?: PinReason | null;
  pinnedUntil?: string | null;
  lastInputTokens?: number;
  messageCount?: number;
  updatedAt?: string;
}

export interface ConversationRepo {
  create(c: Conversation, ttlSeconds: number): Promise<void>;
  get(userId: string, id: string): Promise<Conversation | null>;
  list(userId: string): Promise<Conversation[]>;
  update(userId: string, id: string, patch: ConversationPatch): Promise<Conversation | null>;
  delete(userId: string, id: string): Promise<void>;
}

export interface MessageRepo {
  append(m: StoredMessage, ttlSeconds: number): Promise<void>;
  list(conversationId: string): Promise<StoredMessage[]>;
  deleteAll(conversationId: string): Promise<void>;
}

export interface SessionRepo {
  create(s: Session): Promise<void>;
  get(id: string): Promise<Session | null>;
  touch(id: string, lastSeenAt: string, expiresAt: number): Promise<void>;
  delete(id: string): Promise<void>;
  deleteAllForUser(userId: string): Promise<number>;
}

export interface AuditRepo {
  put(e: AuditEvent): Promise<void>;
  listByDay(day: string): Promise<AuditEvent[]>;
}

export interface UsageRepo {
  add(userId: string, day: string, model: string, usage: UsageSummary): Promise<void>;
  get(userId: string, day: string): Promise<UsageRow | null>;
  listByDay(day: string): Promise<UsageRow[]>;
}

export interface DirectoryUser { id: string; email: string; name: string; role: Role; enabled: boolean; createdAt: string }
export interface UserDirectory {
  list(): Promise<DirectoryUser[]>;
  create(input: { email: string; name: string; role: Role }): Promise<DirectoryUser>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** Changes the role (admin group membership). Takes effect at the user's next sign-in. */
  setRole(id: string, role: Role): Promise<void>;
}

export interface Repos { conversations: ConversationRepo; messages: MessageRepo; sessions: SessionRepo; audit: AuditRepo; usage: UsageRepo }
