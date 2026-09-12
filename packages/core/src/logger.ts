/**
 * Logger de esquema cerrado: solo acepta claves de una lista blanca y valores escalares.
 * Cualquier clave de contenido (content, messages, text, title, prompt, body, ...) se rechaza.
 * Es la barrera técnica de "nunca PHI en logs".
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const ALLOWED_LOG_KEYS = new Set([
  "event", "level", "ts", "msg", "requestId", "userId", "sessionId", "conversationId", "messageId",
  "model", "requestedModel", "servedBy", "alias", "effort", "fallbackReason", "refusalCategory", "stopReason",
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "estimatedUsd", "latencyMs",
  "status", "errorClass", "errorCode", "route", "method", "durationMs", "count", "day", "action",
  "breakerState", "attempt", "reason", "version", "port", "mode", "role", "userAgentHash", "ip",
]);

export const FORBIDDEN_LOG_KEYS = new Set([
  "content", "messages", "message", "system", "text", "title", "prompt", "body", "payload", "input", "output",
  "email", "name", "password", "token", "cookie", "authorization", "attachment", "file", "delta", "response", "request",
]);

export class ForbiddenLogKeyError extends Error {
  constructor(key: string) { super(`clave prohibida en log: ${key}`); this.name = "ForbiddenLogKeyError"; }
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export interface SafeLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bound: LogFields): SafeLogger;
}

export interface SafeLoggerOptions {
  level?: LogLevel;
  sink?: (line: string) => void;
  /** En desarrollo se lanza error ante una clave prohibida; en producción se omite la clave y se registra un aviso. */
  strict?: boolean;
  now?: () => Date;
}

export function sanitizeFields(fields: LogFields | undefined, strict: boolean): { out: LogFields; dropped: string[] } {
  const out: LogFields = {};
  const dropped: string[] = [];
  if (!fields) return { out, dropped };
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN_LOG_KEYS.has(k) || !ALLOWED_LOG_KEYS.has(k)) {
      if (strict) throw new ForbiddenLogKeyError(k);
      dropped.push(k);
      continue;
    }
    if (v !== null && v !== undefined && typeof v === "object") {
      if (strict) throw new ForbiddenLogKeyError(k);
      dropped.push(k);
      continue;
    }
    if (typeof v === "string" && v.length > 200) { out[k] = v.slice(0, 200); continue; }
    out[k] = v;
  }
  return { out, dropped };
}

export function createSafeLogger(opts: SafeLoggerOptions = {}): SafeLogger {
  const level = opts.level ?? "info";
  const sink = opts.sink ?? ((line: string) => process.stdout.write(line + "\n"));
  const strict = opts.strict ?? false;
  const now = opts.now ?? (() => new Date());

  const make = (bound: LogFields): SafeLogger => {
    const emit = (lvl: LogLevel, event: string, fields?: LogFields) => {
      if (LEVELS[lvl] < LEVELS[level]) return;
      const { out, dropped } = sanitizeFields({ ...bound, ...fields }, strict);
      const rec: LogFields = { ts: now().toISOString(), level: lvl, event, ...out };
      if (dropped.length) rec["reason"] = `dropped_keys:${dropped.join(",")}`;
      sink(JSON.stringify(rec));
    };
    return {
      debug: (e, f) => emit("debug", e, f),
      info: (e, f) => emit("info", e, f),
      warn: (e, f) => emit("warn", e, f),
      error: (e, f) => emit("error", e, f),
      child: (b) => make({ ...bound, ...b }),
    };
  };
  return make({});
}

export const noopLogger: SafeLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return noopLogger; } };
