import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CircuitBreaker, DEFAULT_CATALOG, FakeProvider, ModelRouter, noopLogger } from "@helixona/core";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DevIdentityProvider } from "../src/auth/dev.js";
import { SessionService } from "../src/auth/session.js";
import { memoryRepos, MemoryUserDirectory } from "../src/repos/memory.js";
import { MemoryAttachmentStore } from "../src/attachments/store.js";
import { PDFDocument } from "pdf-lib";
import type { Deps } from "../src/deps.js";
import type { IdentityProvider } from "../src/auth/cognito.js";
import { PasswordAuthError, type PasswordAuth } from "../src/auth/password.js";

const H = { "x-requested-with": "helixona", "content-type": "application/json" };

function parseSse(body: string): { event: string; data: Record<string, unknown> }[] {
  return body.split("\n\n").filter((b) => b.startsWith("event:")).map((block) => {
    const event = block.match(/^event: (.+)$/m)![1]!;
    const data = JSON.parse(block.match(/^data: (.+)$/m)![1]!);
    return { event, data };
  });
}

async function makeApp(extraEnv: Record<string, string> = {}, identity?: IdentityProvider, passwordAuth: PasswordAuth | null = null) {
  const config = loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", STORE_MODE: "memory", LLM_MODE: "fake", SESSION_SECRET: "test-secret-test-secret", DAILY_QUOTA_USD: "1", WEB_DIST: "/nonexistent", ...extraEnv });
  const repos = memoryRepos();
  const provider = new FakeProvider({ refusalFallbacks: Object.fromEntries(DEFAULT_CATALOG.models.map((m) => [m.modelId, m.refusalFallbacks])), delayMs: 0 });
  const deps: Deps = {
    config, log: noopLogger, catalog: DEFAULT_CATALOG, repos,
    sessions: new SessionService({ repo: repos.sessions, secret: config.SESSION_SECRET!, idleSeconds: config.SESSION_IDLE_SECONDS, absoluteSeconds: config.SESSION_ABSOLUTE_SECONDS }),
    identity: identity ?? new DevIdentityProvider(), directory: new MemoryUserDirectory(), provider,
    router: new ModelRouter({ catalog: DEFAULT_CATALOG, provider, breaker: new CircuitBreaker(), firstEventTimeoutMs: 300 }),
    systemPrompt: { text: "prompt de sistema de prueba", version: "v1" },
    attachments: new MemoryAttachmentStore(),
    passwordAuth,
  };
  const app = await buildApp(deps);
  return { app, repos, deps };
}

async function login(app: FastifyInstance, username = "ana", role = "staff") {
  const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", headers: H, payload: { username, role } });
  expect(r.statusCode).toBe(200);
  const cookie = r.cookies.find((c) => c.name === "hx_session")!;
  return { cookie: `hx_session=${cookie.value}` };
}

describe("API", () => {
  let app: FastifyInstance; let repos: ReturnType<typeof memoryRepos>;
  beforeAll(async () => { ({ app, repos } = await makeApp()); });
  afterAll(async () => { await app.close(); });

  it("health y cabeceras de seguridad", async () => {
    const r = await app.inject({ method: "GET", url: "/api/health" });
    expect(r.json()).toMatchObject({ ok: true });
    expect(r.headers["content-security-policy"]).toContain("img-src 'self' data:");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-frame-options"]).toBe("DENY");
  });

  it("sin sesión → 401; mutación sin cabecera CSRF → 403", async () => {
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/conversations", payload: { modelAlias: "opus" } })).statusCode).toBe(403);
  });

  it("login dev, /me con catálogo, cookie httpOnly", async () => {
    const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", headers: H, payload: { username: "ana" } });
    const c = r.cookies.find((x) => x.name === "hx_session")!;
    expect(c.httpOnly).toBe(true); expect(c.sameSite).toBe("Lax");
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: `hx_session=${c.value}` } });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user.roles).toEqual(["staff"]);
    expect(body.catalog.models.filter((m: { available: boolean }) => m.available).map((m: { alias: string }) => m.alias)).toEqual(["sonnet", "opus", "fable"]);
    expect(body.catalog.models.find((m: { modelId: string }) => m.modelId === "anthropic.claude-opus-4-8")).toMatchObject({ label: "Opus 4.8", available: false });
    expect(body.catalog.defaultAlias).toBe("opus");
  });

  it("cookie manipulada no abre sesión", async () => {
    const { cookie } = await login(app);
    const tampered = cookie.replace(/.$/, (ch) => (ch === "a" ? "b" : "a"));
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: tampered } })).statusCode).toBe(401);
  });

  it("flujo completo: crear conversación con Fable, turno SSE, historial persistido, aislamiento por usuario", async () => {
    const { cookie } = await login(app, "ana");
    const created = await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "fable" } });
    expect(created.statusCode).toBe(201);
    const conv = created.json();
    expect(conv.modelId).toBe("anthropic.claude-fable-5-1");
    expect(conv.title).toMatch(/^Conversation /);

    const turn = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "Hola, redacta una carta" } });
    expect(turn.statusCode).toBe(200);
    expect(turn.headers["content-type"]).toContain("text/event-stream");
    const events = parseSse(turn.body);
    expect(events[0]!.event).toBe("message_start");
    expect(events.some((e) => e.event === "text_delta")).toBe(true);
    const done = events.at(-1)!;
    expect(done.event).toBe("done");
    expect(done.data["model"]).toBe("anthropic.claude-fable-5-1");
    expect((done.data["usage"] as { estimatedUsd: number }).estimatedUsd).toBeGreaterThan(0);

    const detail = await app.inject({ method: "GET", url: `/api/conversations/${conv.id}`, headers: { cookie } });
    expect(detail.json().messages).toHaveLength(2);
    expect(detail.json().messages[1].role).toBe("assistant");
    expect(detail.json().conversation.messageCount).toBe(2);

    const other = await login(app, "bruno");
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conv.id}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: other.cookie } })).json().items).toHaveLength(0);

    const audit = repos.audit.events.filter((e) => e.action === "turn");
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("redacta una carta");
  });

  it("rechazo del clasificador: Fable → Opus 5 y la conversación queda fijada", async () => {
    const { cookie } = await login(app, "carla");
    const conv = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "fable" } })).json();
    const turn = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "/refuse pregunta clínica" } });
    const events = parseSse(turn.body);
    expect(events.some((e) => e.event === "fallback")).toBe(true);
    expect(events.at(-1)!.data["model"]).toBe("anthropic.claude-opus-5");
    const detail = (await app.inject({ method: "GET", url: `/api/conversations/${conv.id}`, headers: { cookie } })).json();
    expect(detail.conversation.pinnedModel).toBe("anthropic.claude-opus-5");
    expect(detail.conversation.pinReason).toBe("refusal");
  });

  it("toda la cadena rechaza: evento refused y no se persiste el turno", async () => {
    const { cookie } = await login(app, "dario");
    const conv = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "sonnet" } })).json();
    const turn = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "/refuse-all x" } });
    const events = parseSse(turn.body);
    expect(events.at(-1)).toEqual({ event: "refused", data: { category: "bio" } });
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conv.id}`, headers: { cookie } })).json().messages).toHaveLength(0);
  });

  it("cuota diaria: al agotarse devuelve error quota_exceeded como evento", async () => {
    const { cookie } = await login(app, "elena");
    const conv = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "opus" } })).json();
    await repos.usage.add("dev-elena", new Date().toISOString().slice(0, 10), "anthropic.claude-opus-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 5 });
    const turn = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "hola" } });
    const events = parseSse(turn.body);
    expect(events[0]!.event).toBe("error");
    expect(events[0]!.data["code"]).toBe("quota_exceeded");
  });

  it("modelo no permitido o desconocido → 400", async () => {
    const { cookie } = await login(app, "fer");
    expect((await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "gpt" } })).statusCode).toBe(400);
  });

  it("borrar conversación elimina mensajes; logout invalida la sesión", async () => {
    const { cookie } = await login(app, "gus");
    const conv = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "opus" } })).json();
    await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "hola" } });
    expect((await app.inject({ method: "DELETE", url: `/api/conversations/${conv.id}`, headers: { ...H, cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/conversations/${conv.id}`, headers: { cookie } })).statusCode).toBe(404);
    expect(await repos.messages.list(conv.id)).toHaveLength(0);
    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...H, cookie } });
    expect(out.json().logoutUrl).toBe("/login");
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("admin: staff no accede; admin crea y deshabilita usuarios (revoca sesiones)", async () => {
    const staff = await login(app, "hugo");
    expect((await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: staff.cookie } })).statusCode).toBe(403);
    const adm = await login(app, "irene", "admin");
    const created = await app.inject({ method: "POST", url: "/api/admin/users", headers: { ...H, cookie: adm.cookie }, payload: { email: "nuevo@clinica.test", name: "Nuevo", role: "staff" } });
    expect(created.statusCode).toBe(201);
    const dis = await app.inject({ method: "POST", url: `/api/admin/users/dev-hugo/disable`, headers: { ...H, cookie: adm.cookie } });
    expect(dis.json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: staff.cookie } })).statusCode).toBe(401);
    const audit = await app.inject({ method: "GET", url: "/api/admin/audit", headers: { cookie: adm.cookie } });
    expect(audit.json().items.some((e: { action: string }) => e.action === "admin_user_disable")).toBe(true);
  });

  it("modo dev bloqueado en producción", () => {
    expect(() => loadConfig({ NODE_ENV: "production", AUTH_MODE: "dev", STORE_MODE: "dynamo", LLM_MODE: "bedrock", APP_BASE_URL: "https://x.y", SESSION_SECRET: "1234567890123456", AWS_REGION: "us-east-1", TABLE_CONVERSATIONS: "a", TABLE_MESSAGES: "b", TABLE_SESSIONS: "c", TABLE_AUDIT: "d", TABLE_USAGE: "e" })).toThrow(/AUTH_MODE=dev/);
  });
});

describe("Cognito login flow (signed OIDC cookie)", () => {
  const COGNITO_ENV = { AUTH_MODE: "cognito", COGNITO_REGION: "us-east-1", COGNITO_USER_POOL_ID: "us-east-1_test", COGNITO_CLIENT_ID: "client", COGNITO_CLIENT_SECRET: "secret", COGNITO_DOMAIN: "https://example.auth.us-east-1.amazoncognito.com" };
  const identity: IdentityProvider = {
    beginLogin: () => ({ url: "https://example.auth.us-east-1.amazoncognito.com/oauth2/authorize?state=abc", pending: { state: "abc", verifier: "v", exp: Date.now() + 60_000 } }),
    completeLogin: async () => ({ id: "u1", email: "u1@example.test", name: "U1", roles: ["staff"], refreshToken: null }),
    revoke: async () => {},
    logoutUrl: () => "https://example.auth.us-east-1.amazoncognito.com/logout",
  };

  it("GET /api/auth/login redirects to Cognito and sets a signed hx_oidc cookie", async () => {
    const { app } = await makeApp(COGNITO_ENV, identity);
    const r = await app.inject({ method: "GET", url: "/api/auth/login" });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toContain("/oauth2/authorize");
    const oidc = r.cookies.find((c) => c.name === "hx_oidc");
    expect(oidc).toBeDefined();
    expect(oidc!.value).toContain("."); // signed value: payload.signature
    // Callback with a mismatched state must be rejected (exercises unsignCookie), not 500.
    const cb = await app.inject({ method: "GET", url: "/api/auth/callback?code=x&state=wrong", headers: { cookie: `hx_oidc=${oidc!.value}` } });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe("/login?error=state");
    // Matching state completes the login and creates a session.
    const ok = await app.inject({ method: "GET", url: "/api/auth/callback?code=x&state=abc", headers: { cookie: `hx_oidc=${oidc!.value}` } });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe("/");
    expect(ok.cookies.find((c) => c.name === "hx_session")).toBeDefined();
    await app.close();
  });
});

describe("Admin: roles", () => {
  it("an admin can change a user's role; not their own; staff cannot", async () => {
    const { app } = await makeApp();
    const adm = await login(app, "root", "admin");
    const created = await app.inject({ method: "POST", url: "/api/admin/users", headers: { ...H, cookie: adm.cookie }, payload: { email: "luz@example.test", name: "Luz", role: "staff" } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const r = await app.inject({ method: "POST", url: `/api/admin/users/${id}/role`, headers: { ...H, cookie: adm.cookie }, payload: { role: "admin" } });
    expect(r.json()).toEqual({ ok: true });
    const list = await app.inject({ method: "GET", url: "/api/admin/users", headers: { cookie: adm.cookie } });
    expect(list.json().items.find((u: { id: string }) => u.id === id).role).toBe("admin");
    const self = await app.inject({ method: "POST", url: "/api/admin/users/dev-root/role", headers: { ...H, cookie: adm.cookie }, payload: { role: "staff" } });
    expect(self.statusCode).toBe(400);
    const staff = await login(app, "pepe", "staff");
    const reset = await app.inject({ method: "POST", url: `/api/admin/users/${id}/mfa/reset`, headers: { ...H, cookie: adm.cookie } });
    expect(reset.json()).toEqual({ ok: true });
    const resetDenied = await app.inject({ method: "POST", url: `/api/admin/users/${id}/mfa/reset`, headers: { ...H, cookie: staff.cookie } });
    expect(resetDenied.statusCode).toBe(403);
    const denied = await app.inject({ method: "POST", url: `/api/admin/users/${id}/role`, headers: { ...H, cookie: staff.cookie }, payload: { role: "staff" } });
    expect(denied.statusCode).toBe(403);
    await app.close();
  });
});

describe("Attachments", () => {
  it("presigns an upload, accepts the bytes and attaches the PDF to the turn", async () => {
    const { app } = await makeApp();
    const s = await login(app, "ana");
    const created = await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie: s.cookie }, payload: { modelAlias: "opus" } });
    const convId = created.json().id as string;
    const pdf = await PDFDocument.create();
    pdf.addPage(); pdf.addPage();
    const bytes = Buffer.from(await pdf.save());

    const att = await app.inject({ method: "POST", url: `/api/conversations/${convId}/attachments`, headers: { ...H, cookie: s.cookie }, payload: { name: "EOB March.pdf", size: bytes.length, contentType: "application/pdf" } });
    expect(att.statusCode).toBe(201);
    const a = att.json();
    expect(a.upload.url).toMatch(/^\/api\/dev\/upload\//);
    const up = await app.inject({ method: "PUT", url: a.upload.url, headers: { "content-type": "application/pdf", "x-requested-with": "helixona" }, payload: bytes });
    expect(up.statusCode).toBe(200);

    const r = await app.inject({ method: "POST", url: `/api/conversations/${convId}/messages`, headers: { ...H, cookie: s.cookie }, payload: { text: "Summarize this EOB", attachments: [{ id: a.id, name: a.name }] } });
    expect(r.statusCode).toBe(200);
    expect(parseSse(r.body).some((e) => e.event === "done")).toBe(true);
    const conv = await app.inject({ method: "GET", url: `/api/conversations/${convId}`, headers: { cookie: s.cookie } });
    const user = conv.json().messages.find((m: { role: string }) => m.role === "user");
    expect(user.attachments).toEqual([expect.objectContaining({ id: a.id, name: "EOB March.pdf", contentType: "application/pdf", pages: 2, size: bytes.length })]);

    // A follow-up turn re-sends the document from storage (no error) and an unknown attachment is rejected.
    const again = await app.inject({ method: "POST", url: `/api/conversations/${convId}/messages`, headers: { ...H, cookie: s.cookie }, payload: { text: "And the total?" } });
    expect(parseSse(again.body).some((e) => e.event === "done")).toBe(true);
    const bad = await app.inject({ method: "POST", url: `/api/conversations/${convId}/messages`, headers: { ...H, cookie: s.cookie }, payload: { text: "x", attachments: [{ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "missing.pdf" }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("attachment_missing");
    const unsupported = await app.inject({ method: "POST", url: `/api/conversations/${convId}/attachments`, headers: { ...H, cookie: s.cookie }, payload: { name: "virus.exe", size: 10, contentType: "application/octet-stream" } });
    expect(unsupported.json().error.code).toBe("unsupported_type");
    await app.close();
  });
});

describe("Password sign-in (in-app)", () => {
  const COGNITO_ENV = { AUTH_MODE: "cognito", COGNITO_REGION: "us-east-1", COGNITO_USER_POOL_ID: "us-east-1_test", COGNITO_CLIENT_ID: "client", COGNITO_CLIENT_SECRET: "secret", COGNITO_DOMAIN: "https://example.auth.us-east-1.amazoncognito.com" };
  const identity: IdentityProvider = {
    beginLogin: () => ({ url: "https://example.test/authorize", pending: { state: "s", verifier: "v", exp: Date.now() + 60_000 } }),
    completeLogin: async () => ({ id: "u1", email: "u1@example.test", name: "U1", roles: ["staff"], refreshToken: null }),
    revoke: async () => {},
    logoutUrl: () => "https://example.test/logout",
  };
  const stub: PasswordAuth = {
    signIn: async (email, password) => {
      if (email === "temp@example.test") return { kind: "challenge", challenge: "NEW_PASSWORD_REQUIRED", session: "sess-1" };
      if (email === "mfa@example.test") return { kind: "challenge", challenge: "MFA", session: "sess-2" };
      if (email === "new@example.test") return { kind: "challenge", challenge: "MFA_SETUP", session: "sess-3", secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Helixona%20Assistant:new%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Helixona%20Assistant" };
      if (password !== "Correct-Horse-1!") throw new PasswordAuthError("invalid_credentials", 401, "Incorrect email or password.");
      return { kind: "ok", identity: { id: "u-pw", email, name: "Pat", roles: ["staff", "admin"], refreshToken: "rt" } };
    },
    respond: async (email, session, challenge, answer) => {
      if (challenge === "MFA" && answer.code === "123456" && session === "sess-2") return { kind: "ok", identity: { id: "u-mfa", email, name: "M", roles: ["staff"], refreshToken: null } };
      if (challenge === "NEW_PASSWORD_REQUIRED" && session === "sess-1") return { kind: "ok", identity: { id: "u-temp", email, name: "T", roles: ["staff"], refreshToken: null } };
      if (challenge === "MFA_SETUP" && answer.code === "654321" && session === "sess-3") return { kind: "ok", identity: { id: "u-new", email, name: "N", roles: ["staff"], refreshToken: null } };
      throw new PasswordAuthError("invalid_code", 400, "The code is incorrect or has expired.");
    },
    forgotPassword: async () => {},
    resetPassword: async () => {},
  };

  it("signs in with email and password and creates a session; wrong password → 401 without the unauthorized hook", async () => {
    const { app } = await makeApp(COGNITO_ENV, identity, stub);
    const bad = await app.inject({ method: "POST", url: "/api/auth/password/signin", headers: H, payload: { email: "pat@example.test", password: "nope" } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("invalid_credentials");
    const ok = await app.inject({ method: "POST", url: "/api/auth/password/signin", headers: H, payload: { email: "Pat@Example.test", password: "Correct-Horse-1!" } });
    expect(ok.statusCode).toBe(200);
    const cookie = ok.cookies.find((c) => c.name === "hx_session")!;
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: `hx_session=${cookie.value}` } });
    expect(me.json().user).toMatchObject({ id: "u-pw", email: "pat@example.test", roles: ["staff", "admin"] });
    await app.close();
  });

  it("handles the temporary-password and authenticator challenges", async () => {
    const { app } = await makeApp(COGNITO_ENV, identity, stub);
    const temp = await app.inject({ method: "POST", url: "/api/auth/password/signin", headers: H, payload: { email: "temp@example.test", password: "Temp-Pass-123!" } });
    expect(temp.json()).toEqual({ challenge: "NEW_PASSWORD_REQUIRED", session: "sess-1" });
    const set = await app.inject({ method: "POST", url: "/api/auth/password/challenge", headers: H, payload: { email: "temp@example.test", session: "sess-1", challenge: "NEW_PASSWORD_REQUIRED", newPassword: "Brand-New-Pass-9!" } });
    expect(set.json()).toEqual({ ok: true });
    const mfa = await app.inject({ method: "POST", url: "/api/auth/password/signin", headers: H, payload: { email: "mfa@example.test", password: "x" } });
    expect(mfa.json()).toEqual({ challenge: "MFA", session: "sess-2" });
    const wrong = await app.inject({ method: "POST", url: "/api/auth/password/challenge", headers: H, payload: { email: "mfa@example.test", session: "sess-2", challenge: "MFA", code: "000000" } });
    expect(wrong.statusCode).toBe(400);
    const right = await app.inject({ method: "POST", url: "/api/auth/password/challenge", headers: H, payload: { email: "mfa@example.test", session: "sess-2", challenge: "MFA", code: "123456" } });
    expect(right.json()).toEqual({ ok: true });
    expect(right.cookies.some((c) => c.name === "hx_session")).toBe(true);
    const forgot = await app.inject({ method: "POST", url: "/api/auth/password/forgot", headers: H, payload: { email: "anyone@example.test" } });
    expect(forgot.json()).toEqual({ ok: true });
    await app.close();
  });

  it("enrolls an authenticator when the pool requires MFA and the user has none (MFA_SETUP)", async () => {
    const { app } = await makeApp(COGNITO_ENV, identity, stub);
    const first = await app.inject({ method: "POST", url: "/api/auth/password/signin", headers: H, payload: { email: "new@example.test", password: "x" } });
    expect(first.json()).toEqual({ challenge: "MFA_SETUP", session: "sess-3", secret: "JBSWY3DPEHPK3PXP", otpauthUrl: expect.stringMatching(/^otpauth:\/\/totp\//) });
    const missing = await app.inject({ method: "POST", url: "/api/auth/password/challenge", headers: H, payload: { email: "new@example.test", session: "sess-3", challenge: "MFA_SETUP" } });
    expect(missing.statusCode).toBe(400);
    const wrong = await app.inject({ method: "POST", url: "/api/auth/password/challenge", headers: H, payload: { email: "new@example.test", session: "sess-3", challenge: "MFA_SETUP", code: "111111" } });
    expect(wrong.json().error.code).toBe("invalid_code");
    const done = await app.inject({ method: "POST", url: "/api/auth/password/challenge", headers: H, payload: { email: "new@example.test", session: "sess-3", challenge: "MFA_SETUP", code: "654321" } });
    expect(done.json()).toEqual({ ok: true });
    expect(done.cookies.some((c) => c.name === "hx_session")).toBe(true);
    await app.close();
  });

  it("is not available in dev mode", async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: "POST", url: "/api/auth/password/signin", headers: H, payload: { email: "a@b.test", password: "x" } });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});

describe("Projects and model switching", () => {
  it("a clinic project is visible to everyone, a private one only to its owner; only owner/admin edit", async () => {
    const { app } = await makeApp();
    const ana = await login(app, "ana", "staff");
    const luis = await login(app, "luis", "staff");
    const adm = await login(app, "root", "admin");
    const shared = await app.inject({ method: "POST", url: "/api/projects", headers: { ...H, cookie: ana.cookie }, payload: { name: "Insurance appeals", instructions: "Always cite the EOB line items.", visibility: "clinic" } });
    expect(shared.statusCode).toBe(201);
    const priv = await app.inject({ method: "POST", url: "/api/projects", headers: { ...H, cookie: ana.cookie }, payload: { name: "My drafts" } });
    expect(priv.json().visibility).toBe("private");
    const seenByLuis = (await app.inject({ method: "GET", url: "/api/projects", headers: { cookie: luis.cookie } })).json().items as { id: string; canEdit: boolean }[];
    expect(seenByLuis.map((p) => p.id)).toEqual([shared.json().id]);
    expect(seenByLuis[0]!.canEdit).toBe(false);
    expect((await app.inject({ method: "PATCH", url: `/api/projects/${shared.json().id}`, headers: { ...H, cookie: luis.cookie }, payload: { name: "Hijack" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/api/projects/${shared.json().id}`, headers: { ...H, cookie: adm.cookie }, payload: { description: "Appeals for denied claims" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/projects/${priv.json().id}`, headers: { cookie: luis.cookie } })).statusCode).toBe(404);
    await app.close();
  });

  it("conversations can live in a project, use its knowledge, and switch model mid-chat", async () => {
    const { app } = await makeApp();
    const ana = await login(app, "ana", "staff");
    const project = (await app.inject({ method: "POST", url: "/api/projects", headers: { ...H, cookie: ana.cookie }, payload: { name: "Appeals", instructions: "Be concise.", visibility: "clinic" } })).json();
    // knowledge file
    const pdf = await PDFDocument.create(); pdf.addPage();
    const bytes = Buffer.from(await pdf.save());
    const k = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/knowledge`, headers: { ...H, cookie: ana.cookie }, payload: { name: "Policy.pdf", size: bytes.length, contentType: "application/pdf" } })).json();
    expect((await app.inject({ method: "PUT", url: k.upload.url, headers: { "content-type": "application/pdf", "x-requested-with": "helixona" }, payload: bytes })).statusCode).toBe(200);
    const registered = await app.inject({ method: "POST", url: `/api/projects/${project.id}/knowledge/${k.id}`, headers: { ...H, cookie: ana.cookie }, payload: { name: k.name } });
    expect(registered.json().knowledge).toEqual([expect.objectContaining({ id: k.id, name: "Policy.pdf", pages: 1 })]);
    // conversation in the project
    const conv = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie: ana.cookie }, payload: { modelAlias: "sonnet", projectId: project.id } })).json();
    expect(conv.projectId).toBe(project.id);
    const turn = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie: ana.cookie }, payload: { text: "Summarize the policy" } });
    expect(parseSse(turn.body).some((e) => e.event === "done")).toBe(true);
    // switch model
    const switched = await app.inject({ method: "PATCH", url: `/api/conversations/${conv.id}`, headers: { ...H, cookie: ana.cookie }, payload: { modelAlias: "opus" } });
    expect(switched.json()).toMatchObject({ modelAlias: "opus", pinnedModel: null });
    const turn2 = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie: ana.cookie }, payload: { text: "And the deductible?" } });
    const start = parseSse(turn2.body).find((e) => e.event === "message_start");
    expect(String(start?.data["model"])).toContain("opus");
    expect((await app.inject({ method: "PATCH", url: `/api/conversations/${conv.id}`, headers: { ...H, cookie: ana.cookie }, payload: { modelAlias: "gpt" } })).statusCode).toBe(400);
    // unknown project → 400
    expect((await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie: ana.cookie }, payload: { modelAlias: "sonnet", projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" } })).statusCode).toBe(400);
    // deleting the project removes its knowledge
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${project.id}`, headers: { ...H, cookie: ana.cookie } })).statusCode).toBe(204);
    await app.close();
  });
});
