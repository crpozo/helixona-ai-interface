import type {
  Agreement,
  FeedbackStatus,
  AgreementFile,
  AgreementsInfo,
  AdminTrainingLog,
  AdminUser,
  ApiErrorBody,
  AuditEvent,
  ChatSseEvent,
  Conversation,
  Me,
  Message,
  TrainingCheckResult,
  TrainingInfo,
  TrainingModuleResult,
  TrainingRecord,
  Project,
  ProjectVisibility,
  Role,
  UsageRow,
} from "./types";
import { readSseStream } from "./sse";

export const CSRF_HEADER = "X-Requested-With";
export const CSRF_VALUE = "helixona";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type UnauthorizedHandler = () => void;
type ActivityHandler = () => void;

const hooks: { onUnauthorized: UnauthorizedHandler | null; onActivity: ActivityHandler | null } = {
  onUnauthorized: null,
  onActivity: null,
};

/** La app registra aquí qué hacer con un 401 (limpiar estado y volver a /login). */
export function setUnauthorizedHandler(fn: UnauthorizedHandler | null) {
  hooks.onUnauthorized = fn;
}
/** Cualquier fetch cuenta como actividad para el temporizador de inactividad. */
export function setActivityHandler(fn: ActivityHandler | null) {
  hooks.onActivity = fn;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = "http_error";
  let message = "An unexpected error occurred.";
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
  } catch {
    // cuerpo no JSON: nos quedamos con el mensaje genérico
  }
  return new ApiError(res.status, code, message);
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal; authFlow?: boolean } = {},
): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET" && method !== "HEAD") headers[CSRF_HEADER] = CSRF_VALUE;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  hooks.onActivity?.();
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    cache: "no-store",
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });

  if (res.status === 401 && !init.authFlow) {
    hooks.onUnauthorized?.();
    throw new ApiError(401, "unauthorized", "Invalid session.");
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---- Auth ----

export function getMe(signal?: AbortSignal): Promise<Me> {
  return request<Me>("/api/me", { signal });
}

export function devLogin(username: string, role: Role): Promise<{ ok: true }> {
  return request<{ ok: true }>("/api/auth/dev-login", { method: "POST", body: { username, role } });
}

export function logout(): Promise<{ logoutUrl: string }> {
  return request<{ logoutUrl: string }>("/api/auth/logout", { method: "POST" });
}

// ---- Password sign-in inside the app ----

export type PasswordChallenge = "NEW_PASSWORD_REQUIRED" | "MFA" | "MFA_SETUP";
export type PasswordResult =
  | { ok: true }
  | { challenge: "NEW_PASSWORD_REQUIRED" | "MFA"; session: string }
  /** Authenticator enrollment: show `otpauthUrl` as a QR code and `secret` as the manual key. */
  | { challenge: "MFA_SETUP"; session: string; secret: string; otpauthUrl: string };

export function passwordSignIn(email: string, password: string): Promise<PasswordResult> {
  return request<PasswordResult>("/api/auth/password/signin", { method: "POST", body: { email, password }, authFlow: true });
}

export function passwordChallenge(input: { email: string; session: string; challenge: PasswordChallenge; newPassword?: string; code?: string }): Promise<PasswordResult> {
  return request<PasswordResult>("/api/auth/password/challenge", { method: "POST", body: input, authFlow: true });
}

export function forgotPassword(email: string): Promise<{ ok: true }> {
  return request<{ ok: true }>("/api/auth/password/forgot", { method: "POST", body: { email }, authFlow: true });
}

export function resetPassword(email: string, code: string, newPassword: string): Promise<{ ok: true }> {
  return request<{ ok: true }>("/api/auth/password/reset", { method: "POST", body: { email, code, newPassword }, authFlow: true });
}

// ---- Conversaciones ----

export async function listConversations(): Promise<Conversation[]> {
  const r = await request<{ items: Conversation[] }>("/api/conversations");
  return r.items;
}

export function createConversation(modelAlias: string, projectId: string | null = null): Promise<Conversation> {
  return request<Conversation>("/api/conversations", { method: "POST", body: projectId ? { modelAlias, projectId } : { modelAlias } });
}

export function getConversation(
  id: string,
  signal?: AbortSignal,
): Promise<{ conversation: Conversation; messages: Message[] }> {
  return request(`/api/conversations/${encodeURIComponent(id)}`, { signal });
}

export function updateConversation(id: string, patch: { title?: string; modelAlias?: string }): Promise<Conversation> {
  return request<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
}

export function renameConversation(id: string, title: string): Promise<Conversation> {
  return updateConversation(id, { title });
}

// ---- Projects ----

export async function listProjects(): Promise<Project[]> {
  const r = await request<{ items: Project[] }>("/api/projects");
  return r.items;
}

export function createProject(input: { name: string; description?: string; instructions?: string; visibility?: ProjectVisibility }): Promise<Project> {
  return request<Project>("/api/projects", { method: "POST", body: input });
}

export function updateProject(id: string, patch: { name?: string; description?: string; instructions?: string; visibility?: ProjectVisibility }): Promise<Project> {
  return request<Project>(`/api/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
}

export function deleteProject(id: string): Promise<void> {
  return request<void>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function createProjectKnowledge(projectId: string, input: { name: string; size: number; contentType: string }): Promise<AttachmentUpload> {
  return request<AttachmentUpload>(`/api/projects/${encodeURIComponent(projectId)}/knowledge`, { method: "POST", body: input });
}

export function registerProjectKnowledge(projectId: string, attachmentId: string, name: string): Promise<Project> {
  return request<Project>(`/api/projects/${encodeURIComponent(projectId)}/knowledge/${encodeURIComponent(attachmentId)}`, { method: "POST", body: { name } });
}

export function deleteProjectKnowledge(projectId: string, attachmentId: string): Promise<Project> {
  return request<Project>(`/api/projects/${encodeURIComponent(projectId)}/knowledge/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
}

export function deleteConversation(id: string): Promise<void> {
  return request<void>(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---- Attachments ----

export interface UploadTarget { url: string; method: "PUT"; headers: Record<string, string>; expiresAt: string }
export interface AttachmentUpload { id: string; name: string; contentType: string; size: number; upload: UploadTarget }

export function createAttachment(conversationId: string, input: { name: string; size: number; contentType: string }): Promise<AttachmentUpload> {
  return request<AttachmentUpload>(`/api/conversations/${encodeURIComponent(conversationId)}/attachments`, { method: "POST", body: input });
}

/** PUTs the file to the presigned URL (S3 in production, the API itself in development) with progress. */
export function uploadFile(target: UploadTarget, file: File, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  hooks.onActivity?.();
  if (target.url.startsWith("mock:")) {
    onProgress(1);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url, true);
    for (const [k, v] of Object.entries(target.headers)) xhr.setRequestHeader(k, v);
    if (target.url.startsWith("/")) xhr.setRequestHeader(CSRF_HEADER, CSRF_VALUE);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new ApiError(xhr.status, "upload_failed", "The file could not be uploaded.")));
    xhr.onerror = () => reject(new ApiError(0, "network", "The file could not be uploaded."));
    xhr.onabort = () => reject(new ApiError(0, "aborted", "Upload canceled."));
    signal?.addEventListener("abort", () => xhr.abort());
    xhr.send(file);
  });
}

const KNOWN_EVENTS = new Set<ChatSseEvent["type"]>([
  "message_start",
  "text_delta",
  "thinking_delta",
  "fallback",
  "model_switched",
  "refused",
  "error",
  "done",
]);

/**
 * Envía un mensaje y devuelve los eventos SSE tipados según el contrato (§4).
 * El llamador puede abortar con `signal` (botón "Stop").
 */
export async function* sendMessage(
  conversationId: string,
  text: string,
  signal: AbortSignal,
  attachments: { id: string; name: string }[] = [],
): AsyncGenerator<ChatSseEvent, void, undefined> {
  hooks.onActivity?.();
  const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      [CSRF_HEADER]: CSRF_VALUE,
    },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify(attachments.length > 0 ? { text, attachments } : { text }),
    signal,
  });

  if (res.status === 401) {
    hooks.onUnauthorized?.();
    throw new ApiError(401, "unauthorized", "Invalid session.");
  }
  if (!res.ok) throw await parseError(res);
  if (!res.body) throw new ApiError(res.status, "no_body", "Empty response from the server.");

  for await (const ev of readSseStream(res.body, signal)) {
    if (!KNOWN_EVENTS.has(ev.event as ChatSseEvent["type"])) continue;
    let data: unknown;
    try {
      data = ev.data === "" ? {} : JSON.parse(ev.data);
    } catch {
      continue; // evento malformado: lo ignoramos en lugar de romper el turno
    }
    hooks.onActivity?.();
    yield { type: ev.event, data } as ChatSseEvent;
  }
}

// ---- Administración ----

export async function adminListUsers(): Promise<AdminUser[]> {
  const r = await request<{ items: AdminUser[] }>("/api/admin/users");
  return r.items;
}

export function adminCreateUser(input: { email: string; name: string; role: Role }): Promise<AdminUser> {
  return request<AdminUser>("/api/admin/users", { method: "POST", body: input });
}

export function adminDisableUser(id: string): Promise<{ ok: true }> {
  return request(`/api/admin/users/${encodeURIComponent(id)}/disable`, { method: "POST" });
}

export function adminEnableUser(id: string): Promise<{ ok: true }> {
  return request(`/api/admin/users/${encodeURIComponent(id)}/enable`, { method: "POST" });
}

export function adminSetRole(id: string, role: Role): Promise<{ ok: true }> {
  return request(`/api/admin/users/${encodeURIComponent(id)}/role`, { method: "POST", body: { role } });
}

/** Lost phone: forgets the user's authenticator so they enroll a new one at the next sign-in. */
export function adminResetMfa(id: string): Promise<{ ok: true }> {
  return request(`/api/admin/users/${encodeURIComponent(id)}/mfa/reset`, { method: "POST" });
}

/** Sends the invitation email again with a new temporary password (users who have not signed in yet). */
export function adminResendInvitation(id: string): Promise<{ ok: true }> {
  return request(`/api/admin/users/${encodeURIComponent(id)}/invitation/resend`, { method: "POST" });
}

/** New temporary password, returned once for the administrator to hand over in person or by phone. */
export function adminSetTemporaryPassword(id: string): Promise<{ temporaryPassword: string }> {
  return request(`/api/admin/users/${encodeURIComponent(id)}/temporary-password`, { method: "POST" });
}

export async function adminUsage(day: string): Promise<UsageRow[]> {
  const r = await request<{ items: UsageRow[] }>(`/api/admin/usage?day=${encodeURIComponent(day)}`);
  return r.items;
}

export async function adminAudit(day: string): Promise<AuditEvent[]> {
  const r = await request<{ items: AuditEvent[] }>(`/api/admin/audit?day=${encodeURIComponent(day)}`);
  return r.items;
}

// ---- Workforce training (knowledge check, completed online; nothing to sign) ----

export function getTraining(): Promise<TrainingInfo> {
  return request<TrainingInfo>("/api/training");
}

/** One letter per question, in order. Graded server-side; the attempt is recorded either way. */
export function submitTrainingCheck(answers: string[]): Promise<{ record: TrainingRecord; result: TrainingCheckResult }> {
  return request("/api/training/check", { method: "POST", body: { answers } });
}

/** In-app course: the answers to one module's questions (keyed by question number). */
export function submitTrainingModule(moduleId: number, answers: Record<number, string>): Promise<{ record: TrainingRecord; result: TrainingModuleResult }> {
  return request(`/api/training/modules/${moduleId}`, { method: "POST", body: { answers } });
}

/** "Skip training, I already know this": the user's attestation, recorded as such in the training log. */
export function attestTraining(): Promise<{ record: TrainingRecord }> {
  return request("/api/training/attest", { method: "POST", body: { attested: true } });
}

export function adminTraining(): Promise<AdminTrainingLog> {
  return request<AdminTrainingLog>("/api/admin/training");
}

/** Records a completion done on paper (the paper knowledge check is on file) so the user is unlocked and the log is complete. */
export function adminRecordPaperTraining(userId: string, input: { completedAt: string; score: number }): Promise<{ record: TrainingRecord }> {
  return request(`/api/admin/training/${encodeURIComponent(userId)}/paper`, { method: "POST", body: input });
}

// ---- Business associate agreements (status public; the clinic's PDF copy for signed-in staff) ----

export function listAgreements(): Promise<AgreementsInfo> {
  return request<AgreementsInfo>("/api/agreements");
}

/** Same-origin download of the clinic's copy (the session cookie authorizes it). */
export function agreementFileUrl(id: Agreement["id"]): string {
  return `/api/agreements/${encodeURIComponent(id)}/file`;
}

export function adminAgreementUpload(id: string, input: { size: number; contentType: string }): Promise<{ upload: UploadTarget }> {
  return request(`/api/admin/agreements/${encodeURIComponent(id)}/upload`, { method: "POST", body: input });
}

export function adminConfirmAgreement(id: string): Promise<{ file: AgreementFile }> {
  return request(`/api/admin/agreements/${encodeURIComponent(id)}/confirm`, { method: "POST", body: {} });
}

export function adminRemoveAgreement(id: string): Promise<void> {
  return request<void>(`/api/admin/agreements/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---- Bug reports (emailed to the maintainer; the app keeps no text) ----

export function reportBug(description: string, page: string): Promise<{ ok: true }> {
  return request("/api/feedback/bug", { method: "POST", body: { description, page } });
}

export function adminFeedbackStatus(): Promise<FeedbackStatus> {
  return request<FeedbackStatus>("/api/admin/feedback");
}

export function adminResendFeedbackConfirmation(): Promise<{ ok: true }> {
  return request("/api/admin/feedback/resend-confirmation", { method: "POST", body: {} });
}

export function adminSendTestBugReport(): Promise<{ ok: true }> {
  return request("/api/admin/feedback/test", { method: "POST", body: {} });
}
