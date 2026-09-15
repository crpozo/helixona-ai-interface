import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CircuitBreaker, DEFAULT_CATALOG, FakeProvider, ModelRouter, noopLogger } from "@helixona/core";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DevIdentityProvider } from "../src/auth/dev.js";
import { SessionService } from "../src/auth/session.js";
import { memoryRepos, MemoryUserDirectory } from "../src/repos/memory.js";
import type { Deps } from "../src/deps.js";
import type { IdentityProvider } from "../src/auth/cognito.js";

const H = { "x-requested-with": "helixona", "content-type": "application/json" };

function parseSse(body: string): { event: string; data: Record<string, unknown> }[] {
  return body.split("\n\n").filter((b) => b.startsWith("event:")).map((block) => {
    const event = block.match(/^event: (.+)$/m)![1]!;
    const data = JSON.parse(block.match(/^data: (.+)$/m)![1]!);
    return { event, data };
  });
}

async function makeApp(extraEnv: Record<string, string> = {}, identity?: IdentityProvider) {
  const config = loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", STORE_MODE: "memory", LLM_MODE: "fake", SESSION_SECRET: "test-secret-test-secret", DAILY_QUOTA_USD: "1", WEB_DIST: "/nonexistent", ...extraEnv });
  const repos = memoryRepos();
  const provider = new FakeProvider({ refusalFallbacks: Object.fromEntries(DEFAULT_CATALOG.models.map((m) => [m.modelId, m.refusalFallbacks])), delayMs: 0 });
  const deps: Deps = {
    config, log: noopLogger, catalog: DEFAULT_CATALOG, repos,
    sessions: new SessionService({ repo: repos.sessions, secret: config.SESSION_SECRET!, idleSeconds: config.SESSION_IDLE_SECONDS, absoluteSeconds: config.SESSION_ABSOLUTE_SECONDS }),
    identity: identity ?? new DevIdentityProvider(), directory: new MemoryUserDirectory(), provider,
    router: new ModelRouter({ catalog: DEFAULT_CATALOG, provider, breaker: new CircuitBreaker(), firstEventTimeoutMs: 300 }),
    systemPrompt: { text: "prompt de sistema de prueba", version: "v1" },
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
