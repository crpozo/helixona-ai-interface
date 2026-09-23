import type { Conversation, Project, StoredMessage, UsageSummary } from "@helixona/core";
import type { AuditEvent, AuditRepo, ConversationPatch, ConversationRepo, DirectoryUser, MessageRepo, ProjectPatch, ProjectRepo, Repos, Session, SessionRepo, TrainingRecord, TrainingRepo, UsageRepo, UsageRow, UserDirectory } from "./types.js";

export class MemoryConversationRepo implements ConversationRepo {
  private data = new Map<string, Conversation>();
  private key(u: string, id: string) { return `${u}|${id}`; }
  async create(c: Conversation) { this.data.set(this.key(c.userId, c.id), { ...c }); }
  async get(userId: string, id: string) { const c = this.data.get(this.key(userId, id)); return c ? { ...c } : null; }
  async list(userId: string) { return [...this.data.values()].filter((c) => c.userId === userId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => ({ ...c })); }
  async update(userId: string, id: string, patch: ConversationPatch) {
    const c = this.data.get(this.key(userId, id)); if (!c) return null;
    const next = { ...c, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() } as Conversation;
    this.data.set(this.key(userId, id), next); return { ...next };
  }
  async delete(userId: string, id: string) { this.data.delete(this.key(userId, id)); }
}

export class MemoryProjectRepo implements ProjectRepo {
  private data = new Map<string, Project>();
  async create(p: Project) { this.data.set(p.id, structuredClone(p)); }
  async get(id: string) { const p = this.data.get(id); return p ? structuredClone(p) : null; }
  async list() { return [...this.data.values()].map((p) => structuredClone(p)); }
  async update(id: string, patch: ProjectPatch) {
    const p = this.data.get(id); if (!p) return null;
    const next = { ...p, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() } as Project;
    this.data.set(id, next); return structuredClone(next);
  }
  async delete(id: string) { this.data.delete(id); }
}

export class MemoryMessageRepo implements MessageRepo {
  private data = new Map<string, StoredMessage[]>();
  async append(m: StoredMessage) { const l = this.data.get(m.conversationId) ?? []; l.push(structuredClone(m)); this.data.set(m.conversationId, l); }
  async list(conversationId: string) { return (this.data.get(conversationId) ?? []).map((m) => structuredClone(m)); }
  async deleteAll(conversationId: string) { this.data.delete(conversationId); }
}

export class MemorySessionRepo implements SessionRepo {
  private data = new Map<string, Session>();
  async create(s: Session) { this.data.set(s.id, { ...s }); }
  async get(id: string) { const s = this.data.get(id); return s ? { ...s } : null; }
  async touch(id: string, lastSeenAt: string, expiresAt: number) { const s = this.data.get(id); if (s) { s.lastSeenAt = lastSeenAt; s.expiresAt = expiresAt; } }
  async delete(id: string) { this.data.delete(id); }
  async deleteAllForUser(userId: string) { let n = 0; for (const [k, s] of this.data) if (s.userId === userId) { this.data.delete(k); n++; } return n; }
}

export class MemoryAuditRepo implements AuditRepo {
  events: AuditEvent[] = [];
  async put(e: AuditEvent) { this.events.push(structuredClone(e)); }
  async listByDay(day: string) { return this.events.filter((e) => e.day === day).map((e) => structuredClone(e)); }
}

export class MemoryUsageRepo implements UsageRepo {
  private data = new Map<string, UsageRow>();
  async add(userId: string, day: string, model: string, u: UsageSummary) {
    const k = `${userId}|${day}`;
    const row = this.data.get(k) ?? { userId, day, turns: 0, inputTokens: 0, outputTokens: 0, estimatedUsd: 0, byModel: {} };
    row.turns += 1; row.inputTokens += u.inputTokens; row.outputTokens += u.outputTokens; row.estimatedUsd += u.estimatedUsd;
    const bm = row.byModel[model] ?? { turns: 0, estimatedUsd: 0 }; bm.turns += 1; bm.estimatedUsd += u.estimatedUsd; row.byModel[model] = bm;
    this.data.set(k, row);
  }
  async get(userId: string, day: string) { const r = this.data.get(`${userId}|${day}`); return r ? structuredClone(r) : null; }
  async listByDay(day: string) { return [...this.data.values()].filter((r) => r.day === day).map((r) => structuredClone(r)); }
}

export class MemoryUserDirectory implements UserDirectory {
  users: DirectoryUser[] = [];
  constructor(seed: DirectoryUser[] = []) { this.users = seed.map((u) => ({ ...u })); }
  async list() { return this.users.map((u) => ({ ...u })); }
  async create(input: { email: string; name: string; role: "staff" | "admin" }) {
    const u: DirectoryUser = { id: `dev-${this.users.length + 1}`, email: input.email, name: input.name, role: input.role, enabled: true, createdAt: new Date().toISOString(), status: "invited" };
    this.users.push(u); return { ...u };
  }
  async setEnabled(id: string, enabled: boolean) { const u = this.users.find((x) => x.id === id); if (u) u.enabled = enabled; }
  async setRole(id: string, role: "staff" | "admin") { const u = this.users.find((x) => x.id === id); if (u) u.role = role; }
  async resetMfa() {} // no authenticator in dev mode
  async resendInvitation(id: string) {
    const u = this.users.find((x) => x.id === id);
    if (!u || u.status !== "invited") throw new Error("not invited");
  }
}

export class MemoryTrainingRepo implements TrainingRepo {
  private data = new Map<string, TrainingRecord>();
  async get(userId: string) { const r = this.data.get(userId); return r ? structuredClone(r) : null; }
  async put(r: TrainingRecord) { this.data.set(r.userId, structuredClone(r)); }
  async list() { return [...this.data.values()].map((r) => structuredClone(r)); }
}

export function memoryRepos(): Repos & { audit: MemoryAuditRepo } {
  return { conversations: new MemoryConversationRepo(), messages: new MemoryMessageRepo(), sessions: new MemorySessionRepo(), audit: new MemoryAuditRepo(), usage: new MemoryUsageRepo(), projects: new MemoryProjectRepo(), training: new MemoryTrainingRepo() };
}
