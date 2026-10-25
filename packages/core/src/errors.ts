import {
  APIConnectionError, APIError, AuthenticationError, BadRequestError, InternalServerError,
  NotFoundError, PermissionDeniedError, RateLimitError, APIUserAbortError,
} from "@anthropic-ai/sdk";

/**
 * Clasificación de errores del SDK para decidir el fallback por indisponibilidad.
 * - availability: 429, 5xx, red/timeout → respaldo + breaker corto.
 * - config: 403/404 o 400 que nombre modelo/retención → respaldo + breaker largo + alarma.
 * - billing: la cuenta del proveedor sin crédito o con la facturación bloqueada → sin respaldo, alarma.
 * - bug: otros 400/422 → sin fallback (enmascararía errores propios).
 * - auth: 401 → sin fallback.
 * - aborted: cancelado por el cliente o por el timeout de primer evento propio.
 */
export type ErrorKind = "availability" | "config" | "billing" | "bug" | "auth" | "aborted" | "unknown";
export interface ClassifiedError { kind: ErrorKind; errorClass: string; status: number | null; fallback: boolean; alarm: boolean; breakerMs: number }

const MODEL_OR_RETENTION = /(model|modelo|retention|retenci|not enabled|access|inference profile|not supported|unsupported|does not exist|invalid model)/i;
// The provider account itself is out of credit or its billing is blocked: every model fails the same way,
// so there is no point in a fallback or a per-model breaker; the people who run the account must act.
const BILLING = /(credit balance|purchase credits|billing|plans? & billing|payment)/i;

export class FirstEventTimeoutError extends Error {
  constructor(ms: number) { super(`no first event within ${ms} ms`); this.name = "FirstEventTimeoutError"; }
}

export function classifyError(err: unknown): ClassifiedError {
  const base = (kind: ErrorKind, errorClass: string, status: number | null, fallback: boolean, alarm: boolean, breakerMs: number): ClassifiedError =>
    ({ kind, errorClass, status, fallback, alarm, breakerMs });

  if (err instanceof FirstEventTimeoutError) return base("availability", "FirstEventTimeoutError", null, true, false, 5 * 60_000);
  if (err instanceof APIUserAbortError) return base("aborted", "APIUserAbortError", null, false, false, 0);
  if (err instanceof RateLimitError) return base("availability", "RateLimitError", 429, true, false, 5 * 60_000);
  if (err instanceof InternalServerError) return base("availability", "InternalServerError", err.status ?? 500, true, false, 5 * 60_000);
  if (err instanceof APIConnectionError) return base("availability", err.name || "APIConnectionError", null, true, false, 5 * 60_000);
  if (err instanceof AuthenticationError) return base("auth", "AuthenticationError", 401, false, true, 0);
  if (err instanceof PermissionDeniedError) {
    if (BILLING.test(safeMessage(err))) return base("billing", "PermissionDeniedError", 403, false, true, 0);
    return base("config", "PermissionDeniedError", 403, true, true, 60 * 60_000);
  }
  if (err instanceof NotFoundError) return base("config", "NotFoundError", 404, true, true, 60 * 60_000);
  if (err instanceof BadRequestError) {
    const msg = safeMessage(err);
    if (BILLING.test(msg)) return base("billing", "BadRequestError", 400, false, true, 0);
    if (MODEL_OR_RETENTION.test(msg)) return base("config", "BadRequestError", 400, true, true, 60 * 60_000);
    return base("bug", "BadRequestError", 400, false, true, 0);
  }
  if (err instanceof APIError) {
    const status = typeof err.status === "number" ? err.status : null;
    if (status !== null && status >= 500) return base("availability", err.name || "APIError", status, true, false, 5 * 60_000);
    return base("bug", err.name || "APIError", status, false, true, 0);
  }
  if (err && typeof err === "object" && (err as { name?: string }).name === "AbortError") return base("aborted", "AbortError", null, false, false, 0);
  return base("unknown", err instanceof Error ? err.name : "unknown", null, false, true, 0);
}

/** Mensaje del error sin contenido del request (solo para clasificar; nunca se registra tal cual). */
function safeMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  return "";
}

/** What to tell the person, by the kind of failure; never the provider's own text. */
export function userMessageFor(error: ClassifiedError, backupPaused: boolean): string {
  switch (error.kind) {
    case "billing":
      return "The assistant's provider account has run out of credit or its billing is blocked. An administrator needs to add credit before anyone can continue.";
    case "config":
      return "The model is not available right now because of a configuration problem. Administrators have been alerted.";
    case "availability":
      if (error.status === 429) return backupPaused ? "The provider is rate-limiting requests right now and the backup model is paused after recent failures. Wait a minute and try again." : "The provider is rate-limiting requests right now. Wait a minute and try again.";
      return backupPaused ? "The model's provider is overloaded or not answering, and the backup model is paused after recent failures. Try again in a moment." : "The model's provider is overloaded or not answering. Try again in a moment.";
    default:
      return "The model is not available right now";
  }
}
