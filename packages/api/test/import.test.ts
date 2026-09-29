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
  const directory = new MemoryUserDirectory();
  const deps: Deps = {
    config, log: noopLogger, catalog: DEFAULT_CATALOG, repos,
    sessions: new SessionService({ repo: repos.sessions, secret: config.SESSION_SECRET!, idleSeconds: config.SESSION_IDLE_SECONDS, absoluteSeconds: config.SESSION_ABSOLUTE_SECONDS }),
    identity: new DevIdentityProvider(), directory, provider,
    router: new ModelRouter({ catalog: DEFAULT_CATALOG, provider, breaker: new CircuitBreaker(), firstEventTimeoutMs: 2000 }),
    systemPrompt: { text: "test system prompt", version: "v1" },
    attachments: store, passwordAuth: null, feedback: new MemoryFeedbackSender(),
  };
  return { app: await buildApp(deps), repos, store, directory };
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
    expect(audit[4]!.meta).toEqual({ imported: 2, skipped: 0, empty: 1, messages: 3, archived: 0 });
    expect(JSON.stringify(audit)).not.toContain("Hemoglobin");
    // Another person's project cannot be a destination.
    const other = await login(app, "bruno");
    const foreign = await post(app, other, "/api/import/claude/conversations", { conversations: [{ sourceId: "c-9", messages: [{ role: "user", text: "x", attachments: [] }], projectId: p1!.id }] });
    const mine = (await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: other } })).json().items;
    expect(foreign.json().conversations[0].status).toBe("imported");
    expect(mine[0].projectId).toBeNull();
  });

  it("a team backup: one shared project everyone is a member of, the Claude projects folded into a file, chats kept beyond the retention period and imported once per place", async () => {
    const { app, repos, store, directory } = await makeApp();
    const ana = await login(app, "ana");
    const bruno = await login(app, "bruno");
    directory.users.push({ id: "dev-carla", email: "carla@dev.local", name: "carla", role: "staff", enabled: false, createdAt: "2026-01-01T00:00:00.000Z", status: "active" });
    const dest = await post(app, ana, "/api/import/claude/destination", { memory: "Clinic in Miami.", memoryFiles: "## /areas/billing.md\n\nBilling notes", projectFiles: "## Project: Chart prep\n\n### Instructions\n\nBe brief.", team: true });
    expect(dest.statusCode).toBe(200);
    expect(dest.json()).toMatchObject({ name: "Backup Claude", members: 1 });
    const project = (await repos.projects.get(dest.json().projectId as string))!;
    expect(project.visibility).toBe("shared");
    expect(project.ownerId).toBe("dev-ana");
    // Every enabled account except the owner; the disabled one is left out.
    expect(project.members.map((m) => [m.id, m.name])).toEqual([["dev-bruno", "bruno"]]);
    expect(project.instructions).toContain("What Claude remembered about the team");
    expect(project.knowledge.map((k) => k.name)).toEqual(["Claude memory files.md", "Claude projects.md"]);
    expect((await store.get(project.knowledge[1]!.key)).toString()).toContain("### Instructions\n\nBe brief.");

    const chats = [
      { sourceId: "c-1", name: "Lab summary", createdAt: "2026-03-01T10:00:00.000Z", projectId: project.id, archive: true, messages: [{ role: "user", text: "Summarize these labs", attachments: [] }, { role: "assistant", text: "Hemoglobin is normal.", attachments: [] }] },
    ];
    const cr = await post(app, ana, "/api/import/claude/conversations", { conversations: chats });
    expect(cr.statusCode).toBe(200);
    const [imported] = cr.json().conversations as Array<{ id: string; status: string }>;
    expect(imported!.status).toBe("imported");
    // The colleague sees the chat, marked as kept, and can continue it.
    const theirs = (await app.inject({ method: "GET", url: "/api/conversations", headers: { cookie: bruno } })).json().items as Array<{ id: string; title: string; projectId: string | null; archived?: boolean; createdByName?: string }>;
    expect(theirs.map((c) => [c.title, c.projectId, c.archived, c.createdByName])).toEqual([["Lab summary", project.id, true, "ana"]]);
    const turn = await post(app, bruno, `/api/conversations/${imported!.id}/messages`, { text: "And the iron?" });
    expect(turn.statusCode).toBe(200);
    expect(turn.body).toContain("event: done");
    expect((await repos.messages.list(imported!.id)).length).toBe(4);
    // Run again: skipped in the team backup; the same chat into a private place of one's own is a different copy.
    expect((await post(app, ana, "/api/import/claude/conversations", { conversations: chats })).json().conversations[0].status).toBe("skipped");
    expect((await post(app, ana, "/api/import/claude/conversations", { conversations: [{ ...chats[0], projectId: null, archive: false }] })).json().conversations[0].status).toBe("imported");
    // Someone who gets an account later is added by running the import again; the project stays the same.
    await login(app, "dora");
    const again = await post(app, ana, "/api/import/claude/destination", { memory: "", team: true });
    expect(again.json()).toMatchObject({ projectId: project.id, members: 2 });
    expect((await repos.projects.get(project.id))!.members.map((m) => m.id)).toEqual(["dev-bruno", "dev-dora"]);
    // A member cannot take the team backup over; an administrator can run it.
    expect((await post(app, bruno, "/api/import/claude/destination", { memory: "", team: true })).statusCode).toBe(403);
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/dev-login", headers: H, payload: { username: "eva", role: "admin" } });
    const eva = `hx_session=${adminLogin.cookies.find((c) => c.name === "hx_session")!.value}`;
    expect((await post(app, eva, "/api/import/claude/destination", { memory: "", team: true })).json()).toMatchObject({ projectId: project.id, members: 3 });
    const audit = repos.audit.events.filter((e) => e.action === "import_claude_conversations");
    expect(audit[0]!.meta).toEqual({ imported: 1, skipped: 0, empty: 0, messages: 2, archived: 1 });
    expect(JSON.stringify(repos.audit.events)).not.toContain("Hemoglobin");
  });
});
