import { describe, expect, it } from "vitest";
import { CircuitBreaker, DEFAULT_CATALOG, FakeProvider, ModelRouter, noopLogger } from "@helixona/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DevIdentityProvider } from "../src/auth/dev.js";
import { SessionService } from "../src/auth/session.js";
import { memoryRepos, MemoryUserDirectory } from "../src/repos/memory.js";
import { MemoryAttachmentStore } from "../src/attachments/store.js";
import { MemoryFeedbackSender } from "../src/feedback.js";
import type { Deps } from "../src/deps.js";

const H = { "x-requested-with": "helixona", "content-type": "application/json" };

async function makeApp() {
  const config = loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", STORE_MODE: "memory", LLM_MODE: "fake", SESSION_SECRET: "test-secret-test-secret", DAILY_QUOTA_USD: "100", WEB_DIST: "/nonexistent", TRAINING_REQUIRED: "false" });
  const repos = memoryRepos();
  const provider = new FakeProvider({ delayMs: 0 });
  const store = new MemoryAttachmentStore();
  const deps: Deps = {
    config, log: noopLogger, catalog: DEFAULT_CATALOG, repos,
    sessions: new SessionService({ repo: repos.sessions, secret: config.SESSION_SECRET!, idleSeconds: config.SESSION_IDLE_SECONDS, absoluteSeconds: config.SESSION_ABSOLUTE_SECONDS }),
    identity: new DevIdentityProvider(), directory: new MemoryUserDirectory(), provider,
    router: new ModelRouter({ catalog: DEFAULT_CATALOG, provider, breaker: new CircuitBreaker(), firstEventTimeoutMs: 2000 }),
    systemPrompt: { text: "test system prompt", version: "v1" },
    attachments: store, passwordAuth: null, feedback: new MemoryFeedbackSender(),
  };
  return { app: await buildApp(deps), repos, store };
}
async function login(app: FastifyInstance, username = "ana"): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", headers: H, payload: { username, role: "staff" } });
  return `hx_session=${r.cookies.find((c) => c.name === "hx_session")!.value}`;
}
const post = (app: FastifyInstance, cookie: string, url: string, payload: unknown) => app.inject({ method: "POST", url, headers: { ...H, cookie }, payload });

describe("Import from Claude", () => {
  it("brings over projects with their documents, the memory as a project's instructions, and chats with their messages, once", async () => {
    const { app, repos, store } = await makeApp();
    const cookie = await login(app);
    const dest = await post(app, cookie, "/api/import/claude/destination", { memory: "Works at Helixona. Prefers tables.", memoryFiles: "## /areas/billing.md\n\nBilling notes" });
    expect(dest.statusCode).toBe(200);
    const destination = dest.json().projectId as string;
    const destProject = (await repos.projects.get(destination))!;
    expect(destProject.name).toBe("Imported from Claude");
    expect(destProject.instructions).toContain("Prefers tables.");
    expect(destProject.knowledge.map((k) => k.name)).toEqual(["Claude memory files.md"]);
    expect((await store.get(destProject.knowledge[0]!.key)).toString()).toContain("Billing notes");
    // Run again: the same project, updated instructions, the memory file replaced rather than added.
    const again = await post(app, cookie, "/api/import/claude/destination", { memory: "Works at Helixona.", memoryFiles: "## /areas/billing.md\n\nNewer notes" });
    expect(again.json().projectId).toBe(destination);
    const after = (await repos.projects.get(destination))!;
    expect(after.instructions).not.toContain("Prefers tables");
    expect(after.knowledge.map((k) => k.name)).toEqual(["Claude memory files.md"]);
    expect((await store.get(after.knowledge[0]!.key)).toString()).toContain("Newer notes");
    expect(await store.head(destProject.knowledge[0]!.key)).toBeNull();

    const pr = await post(app, cookie, "/api/import/claude/projects", { projects: [{ sourceId: "p-1", name: "Chart prep", description: "Prep", instructions: "Be brief.", docs: [{ name: "Ranges.md", text: "# Ranges" }, { name: "Codes", text: "A1" }] }] });
    expect(pr.statusCode).toBe(200);
    const [p1] = pr.json().projects as Array<{ sourceId: string; id: string; docs: number; skipped: boolean }>;
    expect(p1).toMatchObject({ sourceId: "p-1", docs: 2, skipped: false });
    const project = (await repos.projects.get(p1!.id))!;
    expect(project.instructions).toBe("Be brief.");
    expect(project.description).toBe("Imported from Claude: Prep");
    expect(project.knowledge.map((k) => [k.name, k.contentType])).toEqual([["Ranges.md", "text/markdown"], ["Codes.md", "text/markdown"]]);
    expect((await store.get(project.knowledge[0]!.key)).toString()).toBe("# Ranges");
    expect((await post(app, cookie, "/api/import/claude/projects", { projects: [{ sourceId: "p-1", name: "Chart prep" }] })).json().projects[0]).toMatchObject({ id: p1!.id, skipped: true });

    const chats = [
      { sourceId: "c-1", name: "Lab summary", createdAt: "2026-03-01T10:00:00.000Z", updatedAt: "2026-03-01T10:30:00.000Z", projectId: p1!.id, messages: [
        { role: "user", text: "Summarize these labs", createdAt: "2026-03-01T10:00:00.000Z", attachments: [{ name: "labs.pdf", text: "Hemoglobin 13.1" }] },
        { role: "assistant", text: "Hemoglobin is normal.", attachments: [] },
      ] },
      { sourceId: "c-2", name: "", createdAt: "2026-04-02T09:00:00.000Z", projectId: destination, messages: [{ role: "user", text: "Hola", attachments: [] }] },
      { sourceId: "c-3", name: "Empty", messages: [] },
    ];
    const cr = await post(app, cookie, "/api/import/claude/conversations", { conversations: chats });
    expect(cr.statusCode).toBe(200);
    const results = cr.json().conversations as Array<{ sourceId: string; id: string | null; status: string }>;
    expect(results.map((r) => r.status)).toEqual(["imported", "imported", "empty"]);
    const list = (await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie } })).json().items as Array<{ id: string; title: string; projectId: string | null; createdAt: string; messageCount: number }>;
    expect(list.map((c) => [c.title, c.projectId, c.createdAt, c.messageCount])).toEqual([
      ["Imported chat Apr 2, 2026", destination, "2026-04-02T09:00:00.000Z", 1],
      ["Lab summary", p1!.id, "2026-03-01T10:00:00.000Z", 2],
    ]);
    const detail = (await app.inject({ method: "GET", url: `/api/conversations/${results[0]!.id}`, headers: { cookie } })).json();
    expect(detail.messages[0].content).toEqual([
      { type: "document", title: "labs.pdf", source: { type: "text", media_type: "text/plain", data: "Hemoglobin 13.1" } },
      { type: "text", text: "Summarize these labs\n\n[Attached in Claude: labs.pdf]" },
    ]);
    expect(detail.messages[1]).toMatchObject({ role: "assistant", model: null, stopReason: "end_turn" });
    // The chat can be continued here.
    const turn = await post(app, cookie, `/api/conversations/${results[0]!.id}/messages`, { text: "And the iron?" });
    expect(turn.statusCode).toBe(200);
    expect(turn.body).toContain("event: done");
    // A second import of the same export skips what is already here.
    const twice = await post(app, cookie, "/api/import/claude/conversations", { conversations: chats.slice(0, 1) });
    expect(twice.json().conversations[0].status).toBe("skipped");
    expect((await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie } })).json().items).toHaveLength(2);

    const audit = repos.audit.events.filter((e) => e.action.startsWith("import_claude"));
    expect(audit.map((e) => e.action)).toEqual(["import_claude_destination", "import_claude_destination", "import_claude_projects", "import_claude_projects", "import_claude_conversations", "import_claude_conversations"]);
    expect(audit[4]!.meta).toEqual({ imported: 2, skipped: 0, empty: 1, messages: 3 });
    expect(JSON.stringify(audit)).not.toContain("Hemoglobin");
    // Another person's project cannot be a destination.
    const other = await login(app, "bruno");
    const foreign = await post(app, other, "/api/import/claude/conversations", { conversations: [{ sourceId: "c-9", messages: [{ role: "user", text: "x", attachments: [] }], projectId: p1!.id }] });
    const mine = (await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: other } })).json().items;
    expect(foreign.json().conversations[0].status).toBe("imported");
    expect(mine[0].projectId).toBeNull();
  });
});
