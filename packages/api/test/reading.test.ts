import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { BadRequestError, RateLimitError } from "@anthropic-ai/sdk";
import { CircuitBreaker, DEFAULT_CATALOG, FakeProvider, ModelRouter, noopLogger, type AttachmentMeta, type LlmProvider, type StreamParams } from "@helixona/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DevIdentityProvider } from "../src/auth/dev.js";
import { SessionService } from "../src/auth/session.js";
import { memoryRepos, MemoryUserDirectory } from "../src/repos/memory.js";
import { MemoryAttachmentStore } from "../src/attachments/store.js";
import { MemoryFeedbackSender } from "../src/feedback.js";
import { DocumentReader } from "../src/attachments/reader.js";
import { pageLabel, planChunks, planDelivery } from "../src/attachments/planner.js";
import { INLINE, readingPrefix } from "../src/attachments/policy.js";
import type { Deps } from "../src/deps.js";

const H = { "x-requested-with": "helixona", "content-type": "application/json" };
const MiB = 1024 * 1024;
const SONNET = "anthropic.claude-sonnet-5-5";

async function samplePdf(pages: number, label = "Lab report"): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) pdf.addPage([612, 792]).drawText(`${label} page ${i + 1}`, { x: 50, y: 740, size: 12, font });
  return Buffer.from(await pdf.save());
}

function fakeProvider(): FakeProvider {
  return new FakeProvider({ refusalFallbacks: Object.fromEntries(DEFAULT_CATALOG.models.map((m) => [m.modelId, m.refusalFallbacks])), delayMs: 0 });
}

/** Records every request, then passes it on. */
function recording(inner: LlmProvider): { provider: LlmProvider; calls: StreamParams[] } {
  const calls: StreamParams[] = [];
  return { calls, provider: { stream: (p, o) => { calls.push(p); return inner.stream(p, o); } } };
}

function instruction(p: StreamParams): string {
  const last = p.messages[p.messages.length - 1]!;
  const blocks = Array.isArray(last.content) ? last.content : [];
  return blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
}

function range(p: StreamParams): [number, number] | null {
  const m = instruction(p).match(/^Transcribe pages? (\d+)(?:–(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

function readerFor(store: MemoryAttachmentStore, provider: LlmProvider): DocumentReader {
  return new DocumentReader({ store, provider, catalog: DEFAULT_CATALOG, log: noopLogger, modelId: SONNET, effort: "low", chunkConcurrency: 3, fileConcurrency: 1, retryDelaysMs: [1, 1, 1] });
}

async function storedPdf(store: MemoryAttachmentStore, pages: number, name = "labs.pdf"): Promise<AttachmentMeta> {
  const bytes = await samplePdf(pages);
  const key = `conversations/C1/A1/${name}`;
  await store.put(key, bytes, "application/pdf");
  return { id: "A1", name, contentType: "application/pdf", size: bytes.length, pages, key };
}

describe("Planning what goes whole and what is read", () => {
  it("sends small files whole within the request budget, oldest first, and reads the rest", () => {
    const pdf = (id: string, mb: number, pages: number | null) => ({ id, contentType: "application/pdf", size: mb * MiB, pages });
    const plan = planDelivery([pdf("a", 2, 10), pdf("big", 30, 40), pdf("long", 1, 120), pdf("b", 8, 30), pdf("c", 10, 30), { id: "t", contentType: "text/plain", size: 1000, pages: null }]);
    expect(Object.fromEntries(plan)).toEqual({ a: "inline", big: "read", long: "read", b: "inline", c: "read", t: "inline" });
    // Project files come first and use the budget.
    expect(planDelivery([pdf("a", 2, 10)], { bytes: INLINE.budgetBytes - MiB, pages: 0 }).get("a")).toBe("read");
    expect(planDelivery([pdf("a", 2, 10)], { bytes: 0, pages: INLINE.budgetPages - 5 }).get("a")).toBe("read");
    // The same files give the same plan (stable across turns); an unknown page count is estimated from the size.
    expect(planDelivery([pdf("x", 12, null)]).get("x")).toBe("read");
    expect(planDelivery([pdf("y", 0.5, null)]).get("y")).toBe("inline");
  });

  it("cuts a PDF into parts of up to 8 pages, fewer when the pages are heavy", () => {
    expect(planChunks(100_000, 20, 8, 8 * MiB)).toEqual([[1, 8], [9, 16], [17, 20]]);
    expect(planChunks(40 * MiB, 20, 8, 8 * MiB)).toEqual([[1, 4], [5, 8], [9, 12], [13, 16], [17, 20]]);
    expect(planChunks(60 * MiB, 2, 8, 8 * MiB)).toEqual([[1, 1], [2, 2]]);
    expect(planChunks(1, 0, 8, 8 * MiB)).toEqual([]);
    expect(pageLabel([[3, 3], [5, 8]])).toBe("3, 5–8");
  });
});

describe("DocumentReader", () => {
  it("reads a PDF a few pages at a time, in order, and keeps every part and the whole next to the file", async () => {
    const store = new MemoryAttachmentStore();
    const meta = await storedPdf(store, 20);
    const { provider, calls } = recording(fakeProvider());
    const reader = readerFor(store, provider);
    const progress: number[] = [];
    const r = await reader.read(meta, { signal: new AbortController().signal, conversationId: "C1", onProgress: (done) => progress.push(done) });
    expect(r).toMatchObject({ pages: 20, failedPages: [], partsRead: 3, partsCached: 0, cached: false });
    expect(r.text.indexOf("(p. 1)")).toBeLessThan(r.text.indexOf("(p. 9)"));
    expect(r.text.indexOf("(p. 9)")).toBeLessThan(r.text.indexOf("(p. 20)"));
    expect(progress.at(-1)).toBe(20);
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.usage.estimatedUsd).toBeGreaterThan(0);
    const prefix = readingPrefix(meta.key);
    expect(prefix).toBe("conversations/C1/A1/reading-v1/");
    expect([...store.objects.keys()].filter((k) => k.startsWith(prefix)).sort()).toEqual([`${prefix}full.md`, `${prefix}p0001-0008.md`, `${prefix}p0009-0016.md`, `${prefix}p0017-0020.md`]);
    // Each request: the transcribing model at low effort, one part of the PDF, the page range in words.
    expect(calls).toHaveLength(3);
    const first = calls.find((c) => range(c)?.[0] === 1)!;
    expect(first).toMatchObject({ model: SONNET, effort: "low" });
    expect(first.system[0]!.text).toContain("Laboratory results");
    const doc = (first.messages[0]!.content as Array<{ type: string; source?: { data: string } }>)[0]!;
    expect(doc.type).toBe("document");
    expect((await PDFDocument.load(Buffer.from(doc.source!.data, "base64"))).getPageCount()).toBe(8);
    expect(instruction(first)).toBe('Transcribe pages 1–8 of 20 of the file "labs.pdf". The excerpt attached starts at page 1 of the file: number the pages from there.');
    // Asked again: the whole transcription comes from storage, nothing is sent.
    calls.length = 0;
    const again = await reader.read(meta, { signal: new AbortController().signal, conversationId: "C1", onProgress: () => {} });
    expect(again).toMatchObject({ cached: true, text: r.text });
    expect(calls).toHaveLength(0);
  });

  it("splits a part the API refuses until the bad page is isolated, notes it, and retries only that page next time", async () => {
    const store = new MemoryAttachmentStore();
    const meta = await storedPdf(store, 20);
    const fake = fakeProvider();
    const tried: Array<[number, number]> = [];
    const provider: LlmProvider = {
      stream: (p, o) => {
        const r = range(p)!;
        tried.push(r);
        if (r[0] <= 9 && 9 <= r[1]) throw new BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "Could not process PDF" } }, "Could not process PDF", new Headers());
        return fake.stream(p, o);
      },
    };
    const reader = readerFor(store, provider);
    const r = await reader.read(meta, { signal: new AbortController().signal, conversationId: "C1", onProgress: () => {} });
    expect(r.failedPages).toEqual(["9"]);
    expect(r.text).toContain("(p. 9) [These pages could not be read.]");
    expect(r.text).toContain("(p. 10)");
    expect(r.text).toContain("(p. 16)");
    expect(tried).toEqual(expect.arrayContaining([[9, 16], [9, 12], [9, 10], [9, 9], [10, 10], [11, 12], [13, 16]]));
    const prefix = readingPrefix(meta.key);
    expect(store.objects.has(`${prefix}full.md`)).toBe(false);
    tried.length = 0;
    const again = await reader.read(meta, { signal: new AbortController().signal, conversationId: "C1", onProgress: () => {} });
    expect(again.failedPages).toEqual(["9"]);
    expect(tried).toEqual([[9, 9]]);
    expect(again.partsCached).toBeGreaterThan(0);
  });

  it("waits and retries when the service is busy", async () => {
    const store = new MemoryAttachmentStore();
    const meta = await storedPdf(store, 3);
    const fake = fakeProvider();
    let busy = 2;
    const provider: LlmProvider = {
      stream: (p, o) => {
        if (busy-- > 0) throw new RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "slow down", new Headers());
        return fake.stream(p, o);
      },
    };
    const r = await readerFor(store, provider).read(meta, { signal: new AbortController().signal, conversationId: "C1", onProgress: () => {} });
    expect(r.failedPages).toEqual([]);
    expect(r.text).toContain("(p. 3)");
  });

  it("still answers when the saved readings cannot be looked up or kept (storage errors only cost the reuse)", async () => {
    const store = new MemoryAttachmentStore();
    const meta = await storedPdf(store, 12);
    const broken = (key: string) => key.includes("/reading-v1/");
    const failing = Object.assign(Object.create(store) as MemoryAttachmentStore, {
      head: async (key: string) => {
        if (broken(key)) throw Object.assign(new Error("Forbidden"), { name: "AccessDenied" });
        return store.head(key);
      },
      put: async (key: string, body: Buffer, type: string) => {
        if (broken(key)) throw Object.assign(new Error("Slow down"), { name: "SlowDown" });
        return store.put(key, body, type);
      },
    });
    const warnings: string[] = [];
    const log = { ...noopLogger, warn: (event: string) => void warnings.push(event) };
    const reader = new DocumentReader({ store: failing, provider: fakeProvider(), catalog: DEFAULT_CATALOG, log, modelId: SONNET, effort: "low", chunkConcurrency: 3, fileConcurrency: 1, retryDelaysMs: [1, 1, 1] });
    expect(await reader.cached(meta)).toBeNull();
    const r = await reader.read(meta, { signal: new AbortController().signal, conversationId: "C1", onProgress: () => {} });
    expect(r.failedPages).toEqual([]);
    expect(r.partsRead).toBe(2);
    expect(r.text).toContain("(p. 12)");
    expect(warnings).toContain("attachment_reading_lookup_failed");
    expect(warnings).toContain("attachment_reading_save_failed");
  });

  it("reports what each request cost as it finishes, so a reading that is stopped is still counted", async () => {
    const store = new MemoryAttachmentStore();
    const meta = await storedPdf(store, 24);
    const ac = new AbortController();
    const fake = fakeProvider();
    let calls = 0;
    const provider: LlmProvider = {
      stream: (p, o) => {
        // The person presses Stop while the second part is being read.
        if (++calls === 2) ac.abort();
        return fake.stream(p, o);
      },
    };
    const reader = new DocumentReader({ store, provider, catalog: DEFAULT_CATALOG, log: noopLogger, modelId: SONNET, effort: "low", chunkConcurrency: 1, fileConcurrency: 1, retryDelaysMs: [1, 1, 1] });
    const costs: number[] = [];
    await expect(reader.read(meta, { signal: ac.signal, conversationId: "C1", onProgress: () => {}, onUsage: (u) => costs.push(u.estimatedUsd) })).rejects.toBeTruthy();
    expect(costs).toHaveLength(1);
    expect(costs[0]).toBeGreaterThan(0);
    // The part that was read is kept for the next try.
    expect(await store.head(`${readingPrefix(meta.key)}p0001-0008.md`)).not.toBeNull();
  });

  it("reads a PDF that cannot be split in one request, and stops when the turn is stopped", async () => {
    const store = new MemoryAttachmentStore();
    const key = "conversations/C1/A2/odd.pdf";
    await store.put(key, Buffer.from("%PDF-1.4\nnot really a pdf structure\n%%EOF"), "application/pdf");
    const whole = await readerFor(store, fakeProvider()).read({ id: "A2", name: "odd.pdf", contentType: "application/pdf", size: 40, pages: null, key }, { signal: new AbortController().signal, conversationId: "C1", onProgress: () => {} });
    expect(whole.failedPages).toEqual([]);
    expect(whole.text).toContain("(p. 1)");
    expect(store.objects.has("conversations/C1/A2/reading-v1/whole.md")).toBe(true);

    const meta = await storedPdf(store, 40, "long.pdf");
    const ac = new AbortController();
    const reader = readerFor(store, { stream: (p, o) => { ac.abort(); return fakeProvider().stream(p, o); } });
    await expect(reader.read(meta, { signal: ac.signal, conversationId: "C1", onProgress: () => {} })).rejects.toThrow();
  });
});

// ---- Through the chat route ----

async function makeApp(wrap?: (p: LlmProvider) => LlmProvider) {
  const config = loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", STORE_MODE: "memory", LLM_MODE: "fake", SESSION_SECRET: "test-secret-test-secret", DAILY_QUOTA_USD: "100", WEB_DIST: "/nonexistent", TRAINING_REQUIRED: "false" });
  const repos = memoryRepos();
  const fake = fakeProvider();
  const provider = wrap ? wrap(fake) : fake;
  const deps: Deps = {
    config, log: noopLogger, catalog: DEFAULT_CATALOG, repos,
    sessions: new SessionService({ repo: repos.sessions, secret: config.SESSION_SECRET!, idleSeconds: config.SESSION_IDLE_SECONDS, absoluteSeconds: config.SESSION_ABSOLUTE_SECONDS }),
    identity: new DevIdentityProvider(), directory: new MemoryUserDirectory(), provider,
    router: new ModelRouter({ catalog: DEFAULT_CATALOG, provider, breaker: new CircuitBreaker(), firstEventTimeoutMs: 2000 }),
    systemPrompt: { text: "test system prompt", version: "v1" },
    attachments: new MemoryAttachmentStore(),
    passwordAuth: null,
    feedback: new MemoryFeedbackSender(),
  };
  const app = await buildApp(deps);
  return { app, repos, deps, store: deps.attachments as MemoryAttachmentStore };
}

async function login(app: FastifyInstance, username = "ana"): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", headers: H, payload: { username, role: "staff" } });
  return `hx_session=${r.cookies.find((c) => c.name === "hx_session")!.value}`;
}

async function upload(app: FastifyInstance, cookie: string, convId: string, name: string, bytes: Buffer, contentType = "application/pdf") {
  const created = await app.inject({ method: "POST", url: `/api/conversations/${convId}/attachments`, headers: { ...H, cookie }, payload: { name, size: bytes.length, contentType } });
  expect(created.statusCode).toBe(201);
  const a = created.json();
  expect((await app.inject({ method: "PUT", url: a.upload.url, headers: { "content-type": contentType, "x-requested-with": "helixona" }, payload: bytes })).statusCode).toBe(200);
  return { id: a.id as string, name: a.name as string };
}

function parseSse(body: string): { event: string; data: Record<string, unknown> }[] {
  return body.split("\n\n").filter((b) => b.startsWith("event:")).map((block) => ({ event: block.match(/^event: (.+)$/m)![1]!, data: JSON.parse(block.match(/^data: (.+)$/m)![1]!) }));
}

describe("Large attachments in a conversation", () => {
  it("reads the file that does not fit, sends the small ones whole, shows progress, and reuses the transcription next turn", async () => {
    let calls: StreamParams[] = [];
    const { app, repos } = await makeApp((inner) => {
      const r = recording(inner);
      calls = r.calls;
      return r.provider;
    });
    const cookie = await login(app);
    const conv = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "opus" } })).json();
    const big = await upload(app, cookie, conv.id, "Records 2019-2024.pdf", await samplePdf(120));
    const small1 = await upload(app, cookie, conv.id, "CBC March.pdf", await samplePdf(3));
    const small2 = await upload(app, cookie, conv.id, "Lipids.pdf", await samplePdf(2));

    const r = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "Summarize the historical labs", attachments: [big, small1, small2] } });
    expect(r.statusCode).toBe(200);
    const events = parseSse(r.body);
    const files = events.filter((e) => e.event === "files").map((e) => e.data as { phase: string; files: Array<{ name: string; state: string; pages: number; pagesDone: number }> });
    expect(files[0]).toMatchObject({ phase: "reading", files: [{ name: "Records 2019-2024.pdf", state: "queued", pages: 120 }] });
    expect(files.at(-1)).toEqual({ phase: "read", files: [expect.objectContaining({ name: "Records 2019-2024.pdf", state: "done", pages: 120, pagesDone: 120 })] });
    expect(events.findIndex((e) => e.event === "files")).toBeLessThan(events.findIndex((e) => e.event === "message_start"));
    expect(events.some((e) => e.event === "done")).toBe(true);

    // 15 parts read by Sonnet 5.5, then one answer by the conversation's model.
    const readerCalls = calls.filter((c) => range(c));
    expect(readerCalls).toHaveLength(15);
    expect(new Set(readerCalls.map((c) => c.model))).toEqual(new Set([SONNET]));
    const answer = calls.at(-1)!;
    expect(answer.model).toBe("anthropic.claude-opus-5-5");
    const content = answer.messages.at(-1)!.content as Array<{ type: string; title?: string; context?: string; source: { type: string; data: string } }>;
    expect(content.map((b) => [b.type, b.title ?? null, b.source?.type ?? null])).toEqual([
      ["document", "Records 2019-2024.pdf", "text"],
      ["document", "CBC March.pdf", "base64"],
      ["document", "Lipids.pdf", "base64"],
      ["text", null, null],
    ]);
    expect(content[0]!.context).toContain("Transcription of a 120-page PDF");
    expect(content[0]!.source.data).toContain("(p. 120)");

    const stored = (await app.inject({ method: "GET", url: `/api/conversations/${conv.id}`, headers: { cookie } })).json();
    expect(stored.messages[0].attachments.map((a: { name: string; pages: number }) => [a.name, a.pages])).toEqual([["Records 2019-2024.pdf", 120], ["CBC March.pdf", 3], ["Lipids.pdf", 2]]);
    const day = new Date().toISOString().slice(0, 10);
    expect(Object.keys((await repos.usage.get("dev-ana", day))!.byModel)).toEqual(expect.arrayContaining([SONNET, "anthropic.claude-opus-5-5"]));
    const readAudit = repos.audit.events.find((e) => e.action === "attachments_read")!;
    expect(readAudit).toMatchObject({ model: SONNET, meta: { files: 1, pages: 120, partsRead: 15, partsCached: 0, failedFiles: 0 } });
    expect(JSON.stringify(repos.audit.events)).not.toContain("Hemoglobin");

    // Next turn: nothing is read again; the transcription goes with the history, unchanged.
    calls.length = 0;
    const next = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "Any trend in hemoglobin?" } });
    expect(parseSse(next.body).some((e) => e.event === "files")).toBe(false);
    expect(calls.filter((c) => range(c))).toHaveLength(0);
    const firstUser = calls.at(-1)!.messages[0]!.content as Array<{ type: string; source?: { type: string; data: string } }>;
    expect(firstUser[0]!.source!.data).toBe(content[0]!.source.data);
    await app.close();
  });

  it("accepts up to 20 files per message, checks that a PDF is one, and a member of a shared project can attach files", async () => {
    const { app } = await makeApp();
    const cookie = await login(app);
    const conv = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "sonnet" } })).json();
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, "0").replace(/0/g, "A").replace(/1/g, "B")}`, name: `f${i}.pdf` }));
    const tooMany = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "x", attachments: many } });
    expect(tooMany.statusCode).toBe(400);
    const fake = await upload(app, cookie, conv.id, "scan.pdf", Buffer.from("this is not a pdf at all"));
    const bad = await app.inject({ method: "POST", url: `/api/conversations/${conv.id}/messages`, headers: { ...H, cookie }, payload: { text: "x", attachments: [fake] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("not_a_pdf");

    // A shared project's conversation lives under the project: uploads there used to be refused.
    const bea = await login(app, "bea");
    const p = (await app.inject({ method: "POST", url: "/api/projects", headers: { ...H, cookie }, payload: { name: "Chart prep", visibility: "shared" } })).json();
    expect((await app.inject({ method: "POST", url: `/api/projects/${p.id}/members`, headers: { ...H, cookie }, payload: { userId: "dev-bea" } })).statusCode).toBe(200);
    const shared = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "sonnet", projectId: p.id } })).json();
    const att = await upload(app, bea, shared.id, "Labs.pdf", await samplePdf(2));
    const turn = await app.inject({ method: "POST", url: `/api/conversations/${shared.id}/messages`, headers: { ...H, cookie: bea }, payload: { text: "Summarize", attachments: [att] } });
    expect(parseSse(turn.body).some((e) => e.event === "done")).toBe(true);
    await app.close();
  });

  it("keeps project files within what one request can carry", async () => {
    const { app, repos } = await makeApp();
    const cookie = await login(app);
    const p = (await app.inject({ method: "POST", url: "/api/projects", headers: { ...H, cookie }, payload: { name: "Reference" } })).json();
    const big = await app.inject({ method: "POST", url: `/api/projects/${p.id}/knowledge`, headers: { ...H, cookie }, payload: { name: "Manual.pdf", size: 25 * MiB, contentType: "application/pdf" } });
    expect(big.statusCode).toBe(400);
    expect(big.json().error.message).toContain("20 MB");
    await repos.projects.update(p.id, { knowledge: [{ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", name: "Old.pdf", contentType: "application/pdf", size: 17 * MiB, pages: 40, key: `projects/${p.id}/01ARZ3NDEKTSV4RRFFQ69G5FAV/Old.pdf` }] });
    const over = await app.inject({ method: "POST", url: `/api/projects/${p.id}/knowledge`, headers: { ...H, cookie }, payload: { name: "More.pdf", size: 2 * MiB, contentType: "application/pdf" } });
    expect(over.statusCode).toBe(400);
    expect(over.json().error.code).toBe("knowledge_too_large");
    const me = (await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).json();
    expect(me.limits.attachments).toMatchObject({ maxMb: 100, maxPerMessage: 20, knowledgeMaxMb: 20 });
    await app.close();
  });
});
