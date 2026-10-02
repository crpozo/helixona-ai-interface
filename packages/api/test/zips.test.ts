import { afterAll, beforeAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { CircuitBreaker, DEFAULT_CATALOG, FakeProvider, ModelRouter, noopLogger, type AttachmentMeta, type LlmProvider, type StreamParams } from "@helixona/core";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { DevIdentityProvider } from "../src/auth/dev.js";
import { SessionService } from "../src/auth/session.js";
import { memoryRepos, MemoryUserDirectory } from "../src/repos/memory.js";
import { MemoryAttachmentStore } from "../src/attachments/store.js";
import { MemoryFeedbackSender } from "../src/feedback.js";
import { AttachmentProblem, checkUpload, contentBlock, inspectUpload } from "../src/attachments/documents.js";
import { indexZip, openZip, ZIP, zipIndexKey, zipManifest, ZipTools } from "../src/attachments/zips.js";
import type { Deps } from "../src/deps.js";

const H = { "x-requested-with": "helixona", "content-type": "application/json" };

async function sampleZip(extra: Record<string, string | Buffer> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("Checks.csv", "Patient,Amount\nAna,$10.00\nLuis,$25.50\n");
  zip.file("EOBs/EOB 1.pdf", await samplePdf(2));
  zip.file("EOBs/notes.txt", "Aetna paid claim 1\nUHC denied claim 2\n");
  zip.file("site/index.html", "<html><body>Fence prices</body></html>");
  zip.file("photo.png", Buffer.from("89504e470d0a1a0a", "hex"));
  zip.file("notes.docx", "no");
  zip.file("__MACOSX/._Checks.csv", "junk");
  zip.file(".DS_Store", "junk");
  zip.folder("empty");
  for (const [k, v] of Object.entries(extra)) zip.file(k, v);
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}

async function samplePdf(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([200, 200]);
  return Buffer.from(await pdf.save());
}

async function storedZip(store: MemoryAttachmentStore, bytes: Buffer, name = "EOBs.zip", id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"): Promise<AttachmentMeta> {
  const key = `conversations/C1/${id}/${name}`;
  await store.put(key, bytes, "application/zip");
  return checkUpload(store, key, id, name, 100, 10_000);
}

const text = (out: { content: unknown }) => ((out.content as Array<{ type: string; text?: string }>) ?? []).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");

describe("A ZIP attached to a conversation", () => {
  it("is listed on upload: what is inside, what the tools can read, and the list the model gets", async () => {
    const store = new MemoryAttachmentStore();
    const meta = await storedZip(store, await sampleZip());
    expect(meta.contentType).toBe("application/zip");
    expect(meta.zip).toEqual({ files: 6, readable: 5, bytes: expect.any(Number) });
    expect(meta.modelChars).toBeGreaterThan(100);
    // The list is kept next to the file, and sent as the document of the attachment.
    expect(store.objects.has(zipIndexKey(meta))).toBe(true);
    const block = (await contentBlock(store, meta, false)) as { type: string; title: string; context: string; source: { data: string } };
    expect(block.type).toBe("document");
    expect(block.title).toBe("EOBs.zip");
    expect(block.context).toContain("read_zip_files");
    expect(block.source.data).toContain('ZIP "EOBs.zip": 6 files');
    expect(block.source.data).toContain("The tools can read 5 of them (1 PDF, 1 spreadsheet, 2 text files, 1 image). 1 file of other types cannot be read (.docx 1).");
    expect(block.source.data).toContain("Checks.csv · ");
    expect(block.source.data).toContain("notes.docx · 2 B (not readable)");
    expect(block.source.data).not.toContain("__MACOSX");
    expect(block.source.data).not.toContain(".DS_Store");
    // Something that is not a ZIP, or an empty one, is a plain error; a ZIP is not a project file.
    await store.put("conversations/C1/X/bad.zip", Buffer.from("not a zip"), "application/zip");
    await expect(checkUpload(store, "conversations/C1/X/bad.zip", "X", "bad.zip", 100)).rejects.toMatchObject({ code: "not_a_zip" });
    await store.put("conversations/C1/Y/empty.zip", Buffer.from(await new JSZip().generateAsync({ type: "uint8array" })), "application/x-zip-compressed");
    await expect(checkUpload(store, "conversations/C1/Y/empty.zip", "Y", "empty.zip", 100)).rejects.toMatchObject({ code: "zip_empty" });
    await expect(inspectUpload(store, meta.key, meta.id, meta.name, 100)).rejects.toBeInstanceOf(AttachmentProblem);
  });

  it("cuts a very long list and says how to see the rest", async () => {
    const zip = new JSZip();
    for (let i = 0; i < ZIP.manifestMaxLines + 20; i++) zip.file(`docs/file-${String(i).padStart(5, "0")}.txt`, "x");
    const index = indexZip(await openZip(Buffer.from(await zip.generateAsync({ type: "uint8array" }))));
    expect(index.files).toBe(ZIP.manifestMaxLines + 20);
    const manifest = zipManifest("big.zip", index);
    expect(manifest.split("\n")).toHaveLength(ZIP.manifestMaxLines + 3);
    expect(manifest).toContain("… and 20 more files: use list_zip_files");
  });

  describe("the tools", () => {
    const store = new MemoryAttachmentStore();
    let meta: AttachmentMeta;
    let tools: ZipTools;
    const signal = new AbortController().signal;
    beforeAll(async () => {
      meta = await storedZip(store, await sampleZip({ "big.txt": "y".repeat(5000), "EOBs/long.pdf": await samplePdf(120) }));
      tools = new ZipTools({ store, log: noopLogger, zips: [meta], sheetChars: 10_000 });
    });

    it("read: text as text, CSV as rows, a PDF as the document, an image as an image; a missing path is named", async () => {
      const call = { id: "t1", name: "read_zip_files", input: { attachment: "EOBs.zip", paths: ["EOBs/notes.txt", "Checks.csv", "EOBs/EOB 1.pdf", "photo.png", "nope/Checks.csv", "notes.docx"] } };
      expect(tools.describe(call)).toBe("Reading 6 files from EOBs.zip: notes.txt, Checks.csv, EOB 1.pdf and 3 more");
      const out = await tools.execute(call, signal);
      expect(out.isError).toBeFalsy();
      expect(out.summary).toBe("Read 4 files from EOBs.zip: notes.txt, Checks.csv, EOB 1.pdf and 1 more (1 path not found)");
      const t = text(out);
      expect(t).toContain("=== EOBs.zip › EOBs/notes.txt (38 B) ===\nAetna paid claim 1");
      expect(t).toContain("=== EOBs.zip › Checks.csv");
      expect(t).toMatch(/Row.*Patient.*Amount/);
      expect(t).toContain("Ana");
      expect(t).toContain("2 pages.");
      expect(t).toContain("[document]");
      expect(t).toContain("[image]");
      expect(t).toContain("=== EOBs.zip › nope/Checks.csv ===\nNot in the ZIP. Did you mean: Checks.csv?");
      expect(t).toContain("This type (.docx) cannot be read here.");
      const blocks = out.content as Array<{ type: string; title?: string; source?: { media_type: string } }>;
      expect(blocks.find((b) => b.type === "document")).toMatchObject({ title: "EOBs/EOB 1.pdf", source: { media_type: "application/pdf" } });
      expect(blocks.find((b) => b.type === "image")).toMatchObject({ source: { media_type: "image/png" } });
    });

    it("read: a long text file is cut with the offset to continue, and a long PDF is refused with advice", async () => {
      const first = await tools.execute({ id: "t2", name: "read_zip_files", input: { attachment: "EOBs.zip", paths: ["big.txt"], max_chars: 1000 } }, signal);
      expect(text(first)).toContain("[cut at character 1,000 of 5,000; call read_zip_files with offset: 1000 to continue]");
      const next = await tools.execute({ id: "t3", name: "read_zip_files", input: { attachment: "EOBs.zip", paths: ["big.txt"], max_chars: 1000, offset: 4500 } }, signal);
      expect(text(next)).toContain("From character 4,500.");
      expect(text(next)).not.toContain("[cut at");
      const long = await tools.execute({ id: "t4", name: "read_zip_files", input: { attachment: "EOBs.zip", paths: ["EOBs/long.pdf"] } }, signal);
      expect(long.isError).toBe(true);
      expect(text(long)).toContain("This PDF has 120 pages, more than the 100 that can be read from inside the ZIP. Ask the person to attach it to the chat on its own");
      expect(long.summary).toBe("Nothing readable among 1 path in EOBs.zip");
    });

    it("search: plain text and regular expressions over the text-like files, with file and line", async () => {
      const out = await tools.execute({ id: "s1", name: "search_zip_files", input: { attachment: "EOBs.zip", query: "claim" } }, signal);
      expect(out.summary).toBe("Searched EOBs.zip for \"claim\": 2 matches in 1 file");
      expect(text(out)).toContain("EOBs/notes.txt:1: Aetna paid claim 1");
      expect(text(out)).toContain("EOBs/notes.txt:2: UHC denied claim 2");
      const re = await tools.execute({ id: "s2", name: "search_zip_files", input: { attachment: "EOBs.zip", query: "^(ana|luis),", regex: true } }, signal);
      expect(text(re)).toContain("Checks.csv:2: Ana,$10.00");
      expect(text(re)).toContain("Checks.csv:3: Luis,$25.50");
      const scoped = await tools.execute({ id: "s3", name: "search_zip_files", input: { attachment: "EOBs.zip", query: "fence", prefix: "EOBs/" } }, signal);
      expect(text(scoped)).toContain("0 matching lines in 0 files");
      const bad = await tools.execute({ id: "s4", name: "search_zip_files", input: { attachment: "EOBs.zip", query: "(", regex: true } }, signal);
      expect(bad.isError).toBe(true);
    });

    it("list: by folder, by pattern, with a limit; and names the ZIPs when the name is wrong", async () => {
      const folder = await tools.execute({ id: "l1", name: "list_zip_files", input: { attachment: "EOBs.zip", prefix: "EOBs/" } }, signal);
      expect(folder.summary).toBe("Listed 3 files in EOBs.zip under EOBs/");
      expect(text(folder)).toContain("EOBs/EOB 1.pdf · ");
      const glob = await tools.execute({ id: "l2", name: "list_zip_files", input: { attachment: "EOBs.zip", pattern: "*.pdf" } }, signal);
      expect(text(glob).split("\n").slice(1)).toEqual([expect.stringContaining("EOBs/EOB 1.pdf"), expect.stringContaining("EOBs/long.pdf")]);
      const limited = await tools.execute({ id: "l3", name: "list_zip_files", input: { attachment: "EOBs.zip", limit: 2 } }, signal);
      expect(text(limited)).toContain("(first 2 shown; narrow with prefix or pattern, or raise limit)");
      const other = new ZipTools({ store, log: noopLogger, zips: [meta, { ...meta, id: "2", name: "Other.zip" }], sheetChars: 10_000 });
      const wrong = await other.execute({ id: "l4", name: "list_zip_files", input: { attachment: "Missing.zip" } }, signal);
      expect(wrong.isError).toBe(true);
      expect(text(wrong)).toContain('Attached: "EOBs.zip", "Other.zip".');
      const invalid = await tools.execute({ id: "l5", name: "read_zip_files", input: { attachment: "EOBs.zip" } }, signal);
      expect(invalid.isError).toBe(true);
      expect(text(invalid)).toContain("Invalid input for read_zip_files: paths");
    });
  });
});

function parseSse(body: string): { event: string; data: Record<string, unknown> }[] {
  return body.split("\n\n").filter((b) => b.startsWith("event:")).map((block) => {
    const event = block.match(/^event: (.+)$/m)![1]!;
    const data = JSON.parse(block.match(/^data: (.+)$/m)![1]!);
    return { event, data };
  });
}

/** Records every request, then passes it on. */
function recording(inner: LlmProvider): { provider: LlmProvider; calls: StreamParams[] } {
  const calls: StreamParams[] = [];
  return { calls, provider: { stream: (p, o) => { calls.push(p); return inner.stream(p, o); } } };
}

describe("A turn over a ZIP, end to end", () => {
  let app: FastifyInstance;
  let calls: StreamParams[];
  let store: MemoryAttachmentStore;
  let cookie: string;
  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: "test", AUTH_MODE: "dev", STORE_MODE: "memory", LLM_MODE: "fake", SESSION_SECRET: "test-secret-test-secret", WEB_DIST: "/nonexistent", TRAINING_REQUIRED: "false" });
    const repos = memoryRepos();
    const rec = recording(new FakeProvider({ refusalFallbacks: Object.fromEntries(DEFAULT_CATALOG.models.map((m) => [m.modelId, m.refusalFallbacks])), delayMs: 0 }));
    calls = rec.calls;
    store = new MemoryAttachmentStore();
    const deps: Deps = {
      config, log: noopLogger, catalog: DEFAULT_CATALOG, repos,
      sessions: new SessionService({ repo: repos.sessions, secret: config.SESSION_SECRET!, idleSeconds: config.SESSION_IDLE_SECONDS, absoluteSeconds: config.SESSION_ABSOLUTE_SECONDS }),
      identity: new DevIdentityProvider(), directory: new MemoryUserDirectory([]), provider: rec.provider,
      router: new ModelRouter({ catalog: DEFAULT_CATALOG, provider: rec.provider, breaker: new CircuitBreaker(), firstEventTimeoutMs: 300 }),
      systemPrompt: { text: "prompt de sistema de prueba", version: "v1" },
      attachments: store,
      passwordAuth: null,
      feedback: new MemoryFeedbackSender(),
    };
    app = await buildApp(deps);
    const r = await app.inject({ method: "POST", url: "/api/auth/dev-login", headers: H, payload: { username: "ana", role: "staff" } });
    cookie = `hx_session=${r.cookies.find((c) => c.name === "hx_session")!.value}`;
  });
  afterAll(async () => { await app.close(); });

  async function attachZip(convId: string, name = "EOBs.zip") {
    const bytes = await sampleZip();
    const att = (await app.inject({ method: "POST", url: `/api/conversations/${convId}/attachments`, headers: { ...H, cookie }, payload: { name, size: bytes.length, contentType: "application/x-zip-compressed" } })).json();
    expect((await app.inject({ method: "PUT", url: att.upload.url, headers: { "content-type": "application/x-zip-compressed", "x-requested-with": "helixona" }, payload: bytes })).statusCode).toBe(200);
    return att as { id: string; name: string };
  }

  it("the model reads inside the archive with a tool; the steps stream, the rounds are kept and replayed, older ones trimmed", async () => {
    const convId = (await app.inject({ method: "POST", url: "/api/conversations", headers: { ...H, cookie }, payload: { modelAlias: "opus" } })).json().id as string;
    const a = await attachZip(convId);
    const r = await app.inject({ method: "POST", url: `/api/conversations/${convId}/messages`, headers: { ...H, cookie }, payload: { text: "What is in the checks file?", attachments: [{ id: a.id, name: a.name }] } });
    expect(r.statusCode).toBe(200);
    const events = parseSse(r.body);
    const stepTexts = events.filter((e) => e.event === "step").flatMap((e) => (e.data.steps as Array<{ text: string; state: string }>).map((s) => `${s.state}: ${s.text}`));
    expect(stepTexts).toEqual([
      "done: Opened EOBs.zip: 6 files (5 readable, 1 of other types). The model reads the ones it needs",
      "running: Reading 1 file from EOBs.zip: Checks.csv",
      "done: Read 1 file from EOBs.zip: Checks.csv",
    ]);
    expect(events.find((e) => e.event === "round")?.data).toEqual({ round: 1, note: "Let me read the files first." });
    const answer = events.filter((e) => e.event === "text_delta").map((e) => e.data.text).join("");
    expect(answer).toContain("Read from the ZIP:");
    expect(answer).toContain("Ana");
    expect(events.at(-1)!.event).toBe("done");
    // Two requests: the first offered the tools, the second carried the tool result.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.tools?.map((t) => (t as { name: string }).name)).toEqual(["list_zip_files", "read_zip_files", "search_zip_files"]);
    const last = calls[1]!.messages.at(-1)!;
    expect((last.content as Array<{ type: string }>)[0]!.type).toBe("tool_result");

    // Stored: the archive's metadata on the user turn, the activity list on the answer, the rounds in storage.
    const conv = (await app.inject({ method: "GET", url: `/api/conversations/${convId}`, headers: { cookie } })).json();
    const user = conv.messages.find((m: { role: string }) => m.role === "user");
    expect(user.attachments[0]).toMatchObject({ name: "EOBs.zip", contentType: "application/zip", zip: { files: 6, readable: 5 } });
    const assistant = conv.messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistant.tools.steps.map((s: { text: string }) => s.text)).toEqual(["Let me read the files first.", "Read 1 file from EOBs.zip: Checks.csv"]);
    expect(assistant.content.map((b: { type: string }) => b.type)).toEqual(["text"]);
    expect(store.objects.has(assistant.tools.key)).toBe(true);

    // A follow-up without the archive: the first turn is replayed round by round, and the tools stay on offer.
    calls.length = 0;
    const again = await app.inject({ method: "POST", url: `/api/conversations/${convId}/messages`, headers: { ...H, cookie }, payload: { text: "Thanks" } });
    expect(parseSse(again.body).at(-1)!.event).toBe("done");
    expect(calls).toHaveLength(1);
    const roles = calls[0]!.messages.map((m) => `${m.role}:${(m.content as Array<{ type: string }>).map((b) => b.type).join("+")}`);
    expect(roles).toEqual(["user:document+text", "assistant:text+tool_use", "user:tool_result", "assistant:text", "user:text"]);
    expect(calls[0]!.tools).toHaveLength(3);

    // Three tool turns later, only the two most recent are replayed in full.
    for (const name of ["Second.zip", "Third.zip"]) {
      const z = await attachZip(convId, name);
      await app.inject({ method: "POST", url: `/api/conversations/${convId}/messages`, headers: { ...H, cookie }, payload: { text: "And this one?", attachments: [{ id: z.id, name: z.name }] } });
    }
    calls.length = 0;
    await app.inject({ method: "POST", url: `/api/conversations/${convId}/messages`, headers: { ...H, cookie }, payload: { text: "Thanks again" } });
    const replay = calls[0]!.messages.map((m) => `${m.role}:${(m.content as Array<{ type: string }>).map((b) => b.type).join("+")}`);
    expect(replay.filter((x) => x === "user:tool_result")).toHaveLength(2);
    expect(replay[1]).toBe("assistant:text");
  });
});
