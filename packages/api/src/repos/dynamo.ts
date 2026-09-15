import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { Conversation, Project, StoredMessage, UsageSummary } from "@helixona/core";
import type { AuditEvent, AuditRepo, ConversationPatch, ConversationRepo, MessageRepo, ProjectPatch, ProjectRepo, Repos, Session, SessionRepo, UsageRepo, UsageRow } from "./types.js";

export interface DynamoTables { conversations: string; messages: string; sessions: string; audit: string; usage: string; projects: string }

const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const pad = (n: number) => String(n).padStart(6, "0");

export class DynamoConversationRepo implements ConversationRepo {
  constructor(private readonly doc: DynamoDBDocumentClient, private readonly table: string) {}
  async create(c: Conversation, ttlSeconds: number) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...c, conversationId: c.id, expiresAt: epoch(new Date()) + ttlSeconds }, ConditionExpression: "attribute_not_exists(conversationId)" }));
  }
  async get(userId: string, id: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { userId, conversationId: id } }));
    return r.Item ? fromItem(r.Item) : null;
  }
  async list(userId: string) {
    const r = await this.doc.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: "userId = :u", ExpressionAttributeValues: { ":u": userId }, Limit: 500 }));
    return (r.Items ?? []).map(fromItem).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async update(userId: string, id: string, patch: ConversationPatch) {
    const entries = Object.entries({ ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() }).filter(([, v]) => v !== undefined);
    const names: Record<string, string> = {}; const values: Record<string, unknown> = {};
    const sets = entries.map(([k, v], i) => { names[`#k${i}`] = k; values[`:v${i}`] = v; return `#k${i} = :v${i}`; });
    const r = await this.doc.send(new UpdateCommand({ TableName: this.table, Key: { userId, conversationId: id }, UpdateExpression: `SET ${sets.join(", ")}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ConditionExpression: "attribute_exists(conversationId)", ReturnValues: "ALL_NEW" })).catch((e: { name?: string }) => { if (e.name === "ConditionalCheckFailedException") return null; throw e; });
    return r?.Attributes ? fromItem(r.Attributes) : null;
  }
  async delete(userId: string, id: string) { await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { userId, conversationId: id } })); }
}

function fromItem(i: Record<string, unknown>): Conversation {
  const { conversationId, expiresAt: _e, ...rest } = i as Record<string, unknown> & { conversationId: string };
  const c = { ...(rest as unknown as Conversation), id: conversationId };
  return { ...c, projectId: c.projectId ?? null };
}

export class DynamoProjectRepo implements ProjectRepo {
  constructor(private readonly doc: DynamoDBDocumentClient, private readonly table: string) {}
  async create(p: Project) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...p, projectId: p.id }, ConditionExpression: "attribute_not_exists(projectId)" }));
  }
  async get(id: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { projectId: id } }));
    return r.Item ? projectFromItem(r.Item) : null;
  }
  async list() {
    // Small table (tens of projects per clinic): a scan is fine and avoids an index.
    const out: Project[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new ScanCommand({ TableName: this.table, ExclusiveStartKey: key }));
      out.push(...(r.Items ?? []).map(projectFromItem));
      key = r.LastEvaluatedKey;
    } while (key);
    return out;
  }
  async update(id: string, patch: ProjectPatch) {
    const entries = Object.entries({ ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() }).filter(([, v]) => v !== undefined);
    const names: Record<string, string> = {}; const values: Record<string, unknown> = {};
    const sets = entries.map(([k, v], i) => { names[`#k${i}`] = k; values[`:v${i}`] = v; return `#k${i} = :v${i}`; });
    const r = await this.doc.send(new UpdateCommand({ TableName: this.table, Key: { projectId: id }, UpdateExpression: `SET ${sets.join(", ")}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ConditionExpression: "attribute_exists(projectId)", ReturnValues: "ALL_NEW" })).catch((e: { name?: string }) => { if (e.name === "ConditionalCheckFailedException") return null; throw e; });
    return r?.Attributes ? projectFromItem(r.Attributes) : null;
  }
  async delete(id: string) { await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { projectId: id } })); }
}

function projectFromItem(i: Record<string, unknown>): Project {
  const { projectId, ...rest } = i as Record<string, unknown> & { projectId: string };
  const p = rest as unknown as Project;
  return { ...p, id: projectId, knowledge: Array.isArray(p.knowledge) ? p.knowledge : [] };
}

export class DynamoMessageRepo implements MessageRepo {
  constructor(private readonly doc: DynamoDBDocumentClient, private readonly table: string) {}
  async append(m: StoredMessage, ttlSeconds: number) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...m, seq: pad(m.seq), seqNumber: m.seq, expiresAt: epoch(new Date()) + ttlSeconds } }));
  }
  async list(conversationId: string) {
    const out: StoredMessage[] = [];
    let key: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: "conversationId = :c", ExpressionAttributeValues: { ":c": conversationId }, ExclusiveStartKey: key }));
      for (const it of r.Items ?? []) { const { seqNumber, expiresAt: _e, ...rest } = it as Record<string, unknown> & { seqNumber: number }; out.push({ ...(rest as unknown as StoredMessage), seq: seqNumber }); }
      key = r.LastEvaluatedKey;
    } while (key);
    return out;
  }
  async deleteAll(conversationId: string) {
    const all = await this.list(conversationId);
    for (let i = 0; i < all.length; i += 25) {
      const chunk = all.slice(i, i + 25);
      await this.doc.send(new BatchWriteCommand({ RequestItems: { [this.table]: chunk.map((m) => ({ DeleteRequest: { Key: { conversationId, seq: pad(m.seq) } } })) } }));
    }
  }
}

export class DynamoSessionRepo implements SessionRepo {
  constructor(private readonly doc: DynamoDBDocumentClient, private readonly table: string) {}
  async create(s: Session) { await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...s, sessionId: s.id } })); }
  async get(id: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { sessionId: id }, ConsistentRead: true }));
    if (!r.Item) return null;
    const { sessionId, ...rest } = r.Item as Record<string, unknown> & { sessionId: string };
    return { ...(rest as unknown as Session), id: sessionId };
  }
  async touch(id: string, lastSeenAt: string, expiresAt: number) {
    await this.doc.send(new UpdateCommand({ TableName: this.table, Key: { sessionId: id }, UpdateExpression: "SET lastSeenAt = :l, expiresAt = :e", ExpressionAttributeValues: { ":l": lastSeenAt, ":e": expiresAt }, ConditionExpression: "attribute_exists(sessionId)" })).catch(() => {});
  }
  async delete(id: string) { await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { sessionId: id } })); }
  async deleteAllForUser(userId: string) {
    const r = await this.doc.send(new QueryCommand({ TableName: this.table, IndexName: "byUser", KeyConditionExpression: "userId = :u", ExpressionAttributeValues: { ":u": userId } }));
    let n = 0;
    for (const it of r.Items ?? []) { await this.delete((it as { sessionId: string }).sessionId); n++; }
    return n;
  }
}

/** Tabla append-only: el rol de la tarea solo tiene PutItem y Query (sin Update/Delete). */
export class DynamoAuditRepo implements AuditRepo {
  constructor(private readonly doc: DynamoDBDocumentClient, private readonly table: string) {}
  async put(e: AuditEvent) { await this.doc.send(new PutCommand({ TableName: this.table, Item: { ...e, sk: `${e.ts}#${e.id}` } })); }
  async listByDay(day: string) {
    const r = await this.doc.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: "#d = :d", ExpressionAttributeNames: { "#d": "day" }, ExpressionAttributeValues: { ":d": day }, Limit: 1000 }));
    return (r.Items ?? []).map((i) => { const { sk: _s, ...rest } = i as Record<string, unknown>; return rest as unknown as AuditEvent; });
  }
}

export class DynamoUsageRepo implements UsageRepo {
  constructor(private readonly doc: DynamoDBDocumentClient, private readonly table: string) {}
  async add(userId: string, day: string, model: string, u: UsageSummary) {
    const key = { userId, day };
    const ttl = epoch(new Date()) + 400 * 86400;
    await this.doc.send(new UpdateCommand({ TableName: this.table, Key: key, UpdateExpression: "SET byModel = if_not_exists(byModel, :empty), expiresAt = if_not_exists(expiresAt, :ttl) ADD turns :one, inputTokens :i, outputTokens :o, estimatedUsd :usd", ExpressionAttributeValues: { ":empty": {}, ":ttl": ttl, ":one": 1, ":i": u.inputTokens, ":o": u.outputTokens, ":usd": u.estimatedUsd } }));
    await this.doc.send(new UpdateCommand({ TableName: this.table, Key: key, UpdateExpression: "SET byModel.#m = if_not_exists(byModel.#m, :zero)", ExpressionAttributeNames: { "#m": model }, ExpressionAttributeValues: { ":zero": { turns: 0, estimatedUsd: 0 } } }));
    await this.doc.send(new UpdateCommand({ TableName: this.table, Key: key, UpdateExpression: "ADD byModel.#m.turns :one, byModel.#m.estimatedUsd :usd", ExpressionAttributeNames: { "#m": model }, ExpressionAttributeValues: { ":one": 1, ":usd": u.estimatedUsd } }));
  }
  async get(userId: string, day: string) {
    const r = await this.doc.send(new GetCommand({ TableName: this.table, Key: { userId, day } }));
    return r.Item ? (r.Item as unknown as UsageRow) : null;
  }
  async listByDay(day: string) {
    // Sin GSI por día en la tabla de uso: se escanea con filtro (volumen pequeño; una fila por usuario y día).
    const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
    const r = await this.doc.send(new ScanCommand({ TableName: this.table, FilterExpression: "#d = :d", ExpressionAttributeNames: { "#d": "day" }, ExpressionAttributeValues: { ":d": day } }));
    return (r.Items ?? []) as unknown as UsageRow[];
  }
}

export function dynamoRepos(region: string, tables: DynamoTables): Repos {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  return {
    conversations: new DynamoConversationRepo(doc, tables.conversations),
    messages: new DynamoMessageRepo(doc, tables.messages),
    sessions: new DynamoSessionRepo(doc, tables.sessions),
    audit: new DynamoAuditRepo(doc, tables.audit),
    usage: new DynamoUsageRepo(doc, tables.usage),
    projects: new DynamoProjectRepo(doc, tables.projects),
  };
}
