/**
 * API simulada para la vista previa publicada (modo `demo`): intercepta `fetch` a `/api/*`
 * y responde en memoria, incluido el streaming SSE. Datos de ejemplo, sin Bedrock ni PHI real.
 */
import type { AdminUser, AttachmentMeta, AuditEvent, Conversation, Me, Message, Project, TrainingRecord, UsageRow } from "../lib/types";
import trainingQuiz from "./training-quiz.json";

const MODELS = [
  { alias: "sonnet", modelId: "anthropic.claude-sonnet-5", label: "Sonnet 5", description: "Fast and economical: translations, letters, short summaries", costFactor: 1, available: true },
  { alias: "opus", modelId: "anthropic.claude-opus-5-5", label: "Opus 5.5", description: "Recommended balance for everyday work", costFactor: 2, available: true },
  { alias: "fable", modelId: "anthropic.claude-fable-5-1", label: "Fable 5.1", description: "Maximum capability for difficult tasks and long documents (slower and more expensive)", costFactor: 5, available: true },
  { alias: "anthropic.claude-opus-5", modelId: "anthropic.claude-opus-5", label: "Opus 5", description: "Fallback only", costFactor: 0, available: false },
];
const PRICES: Record<string, [number, number]> = { "anthropic.claude-sonnet-5": [2, 10], "anthropic.claude-opus-5-5": [4, 20], "anthropic.claude-fable-5-1": [10, 50], "anthropic.claude-opus-5": [5, 25] };
const FALLBACK: Record<string, string | undefined> = { "anthropic.claude-fable-5-1": "anthropic.claude-opus-5-5", "anthropic.claude-opus-5-5": "anthropic.claude-opus-5" };

const AGREEMENTS = [
  { id: "aws-baa", vendor: "Amazon Web Services", title: "AWS Business Associate Addendum", since: "2026-09-22", status: "Accepted by the account owner on September 22, 2026", reference: "AWS Artifact (account 148274106093), Agreements, AWS Business Associate Addendum", url: "https://console.aws.amazon.com/artifact/home#/agreements", note: "Covers the HIPAA-eligible AWS services the assistant runs on (Appendix A of the risk analysis)." },
  { id: "anthropic-baa", vendor: "Anthropic", title: "Business Associate Agreement (HIPAA readiness)", since: "2026-09-15", status: "Enabled by the account owner on September 15, 2026", reference: "Claude Console, Settings, Privacy (HIPAA readiness)", url: "https://platform.claude.com/", note: "Covers the assistant's calls to the Anthropic API for every model in the catalog." },
];

let seq = 100;
const id = () => `demo${(seq++).toString(36).padStart(6, "0")}`;
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Conv extends Conversation { messages: Message[] }
const state = {
  loggedIn: true,
  conversations: [] as Conv[],
  users: [
    { id: "u-ana", email: "ana@helixona.com", name: "Ana Perez", role: "admin", enabled: true, createdAt: "2026-09-01T14:00:00Z" },
    { id: "u-luis", email: "luis@helixona.com", name: "Luis Romero", role: "staff", enabled: true, createdAt: "2026-09-02T15:30:00Z" },
    { id: "u-marta", email: "marta@helixona.com", name: "Marta Gil", role: "staff", enabled: false, createdAt: "2026-09-03T09:10:00Z" },
  ] as AdminUser[],
  usage: [] as UsageRow[],
  audit: [] as AuditEvent[],
  training: null as TrainingRecord | null,
  agreements: {} as Record<string, { size: number; uploadedAt: string; source: "uploaded" }>,
  agreementSizes: {} as Record<string, number>,
  projects: [
    { id: "p-appeals", ownerId: "u-ana", name: "Insurance appeals", description: "Denied claims and prior authorizations", instructions: "You help the billing team write appeal letters. Always cite the claim number, the denial reason and the relevant policy language. Keep a professional, factual tone.", visibility: "clinic", knowledge: [{ id: "k-1", name: "Appeal letter template.md", contentType: "text/markdown", size: 4_210, pages: null }], createdAt: "2026-09-10T16:00:00Z", updatedAt: "2026-09-12T10:00:00Z", canEdit: true },
  ] as Project[],
};

function seed() {
  const c1: Conv = {
    id: id(), title: "Sample · appointment reminder letter", modelAlias: "opus", modelId: "anthropic.claude-opus-5-5", pinnedModel: null, pinReason: null,
    createdAt: "2026-09-12T14:02:00Z", updatedAt: "2026-09-12T14:05:00Z", messageCount: 2, messages: [],
  };
  c1.messages.push(
    { id: id(), role: "user", content: [{ type: "text", text: "Write a short letter reminding a patient of their follow-up appointment next Tuesday at 10:00 AM and asking them to bring their latest lab results." }], model: null, fallbackReason: null, stopReason: null, usage: null, createdAt: "2026-09-12T14:02:10Z" },
    { id: id(), role: "assistant", content: [{ type: "text", text: "**Subject: Follow-up appointment reminder**\n\nDear patient,\n\nThis is a reminder that you have a follow-up appointment on **Tuesday at 10:00 AM** at our clinic. Please bring your **most recent lab results** so we can review them during your visit.\n\nIf you need to reschedule, please call us and we will be happy to help.\n\nSincerely,\nThe Helixona Team\n\n---\n*Check the patient's name and the date before sending.*" }], model: "anthropic.claude-opus-5-5", fallbackReason: null, stopReason: "end_turn", usage: { inputTokens: 812, outputTokens: 190, cacheReadTokens: 640, cacheWriteTokens: 0, estimatedUsd: 0.0089 }, createdAt: "2026-09-12T14:02:24Z" },
  );
  const c2: Conv = {
    id: id(), title: "Sample · plain-language instructions", modelAlias: "sonnet", modelId: "anthropic.claude-sonnet-5", pinnedModel: null, pinReason: null,
    createdAt: "2026-09-11T20:40:00Z", updatedAt: "2026-09-11T20:41:00Z", messageCount: 2, messages: [],
  };
  c2.messages.push(
    { id: id(), role: "user", content: [{ type: "text", text: "Rewrite these instructions in plain language for a patient: \"Take the medication with food, once daily, for 14 days. Discontinue and contact the clinic if dizziness occurs.\"" }], model: null, fallbackReason: null, stopReason: null, usage: null, createdAt: "2026-09-11T20:40:05Z" },
    { id: id(), role: "assistant", content: [{ type: "text", text: "\"Take your medicine with food once a day for 14 days. If you feel dizzy, stop taking it and call the clinic.\"" }], model: "anthropic.claude-sonnet-5", fallbackReason: null, stopReason: "end_turn", usage: { inputTokens: 740, outputTokens: 42, cacheReadTokens: 600, cacheWriteTokens: 0, estimatedUsd: 0.0007 }, createdAt: "2026-09-11T20:40:09Z" },
  );
  state.conversations.push(c1, c2);
  state.usage.push({ userId: "u-ana", day: today(), turns: 14, inputTokens: 21040, outputTokens: 5120, estimatedUsd: 0.31, byModel: { "anthropic.claude-opus-5-5": { turns: 9, estimatedUsd: 0.22 }, "anthropic.claude-sonnet-5": { turns: 5, estimatedUsd: 0.09 } } });
  state.usage.push({ userId: "u-luis", day: today(), turns: 6, inputTokens: 9800, outputTokens: 2400, estimatedUsd: 0.41, byModel: { "anthropic.claude-fable-5-1": { turns: 6, estimatedUsd: 0.41 } } });
}
function today() { return now().slice(0, 10); }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function error(status: number, code: string, message: string): Response { return json({ error: { code, message } }, status); }

function me(): Me {
  return {
    user: { id: "u-ana", email: "ana@helixona.com", name: "Ana Perez", roles: ["staff", "admin"] },
    session: { expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(), idleTimeoutSeconds: 900 },
    catalog: { defaultAlias: "opus", effort: "medium", models: MODELS },
    limits: { maxMessageChars: 20000, contextLimitTokens: 150000, attachments: { enabled: true, maxMb: 20, maxPerMessage: 5, accept: ["application/pdf", "text/plain", "text/markdown", "text/csv"] } },
  };
}

function publicConv(c: Conv): Conversation { const { messages: _m, ...rest } = c; return rest; }

function reply(userText: string, model: string): string {
  const t = userText.replace(/^\/\S+\s*/, "").trim();
  const label = MODELS.find((m) => m.modelId === model)?.label ?? model;
  if (/translat/i.test(t)) return `**Translation**\n\n"${t.replace(/^translate (?:(?:into|to) \w+)?:?\s*/i, "").replace(/^"|"$/g, "")}"\n\n*(Sample response generated by the preview, model ${label}.)*`;
  if (/letter|email|message/i.test(t)) return `**Draft**\n\nDear patient,\n\n${t.length > 20 ? "We are writing to you regarding your request. " : ""}Please do not hesitate to contact us with any questions.\n\nSincerely,\nThe Helixona Team\n\n---\n*Check the details before sending. Sample response (${label}).*`;
  if (/summar/i.test(t)) return `**Summary**\n\n- Main point of the text provided.\n- Second relevant point.\n- Suggested action for the team.\n\n*Sample response (${label}).*`;
  return `This is a **preview** of the interface: there is no connection to Bedrock and the responses are samples.\n\nI received your message (${t.length} characters) and would have processed it with **${label}** at \`medium\` effort.\n\nTry starting your message with:\n\n- \`/refuse\` to see a classifier refusal continued by the fallback model\n- \`/refuse-all\` to see a refusal across the entire model chain\n- \`/throttle\` to see a switch due to unavailability\n- \`/long\` to see a truncated response`;
}

function sse(conv: Conv, text: string, signal: AbortSignal | null | undefined, attachments: AttachmentMeta[] = []): Response {
  const cmd = text.match(/^\/(refuse-all|refuse-mid|refuse|throttle|long)\b/)?.[1] ?? null;
  const enc = new TextEncoder();
  const userMessageId = id();
  const assistantMessageId = id();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const requested = conv.pinnedModel ?? conv.modelId;
      let model = requested;
      let fallbackReason: "refusal" | "availability" | null = null;
      try {
        send("message_start", { userMessageId, assistantMessageId, model });
        await sleep(400);
        if (cmd === "refuse-all") { send("refused", { category: "bio" }); controller.close(); return; }
        if (cmd === "throttle") {
          const to = FALLBACK[model];
          if (!to) { send("error", { code: "model_unavailable", message: "The model is currently unavailable", retryable: true, partial: false }); controller.close(); return; }
          send("model_switched", { from: model, to, reason: "availability" }); model = to; fallbackReason = "availability"; await sleep(300);
        }
        if (cmd === "refuse") {
          const to = FALLBACK[model];
          if (!to) { send("refused", { category: "bio" }); controller.close(); return; }
          send("fallback", { from: model, to, reason: "refusal" }); model = to; fallbackReason = "refusal"; await sleep(300);
        }
        const full = reply(text, model);
        const parts = full.match(/.{1,14}/gs) ?? [];
        let emitted = "";
        for (let i = 0; i < parts.length; i++) {
          if (signal?.aborted) { controller.close(); return; }
          if (cmd === "refuse-mid" && i === 6 && FALLBACK[model]) { const to = FALLBACK[model]!; send("fallback", { from: model, to, reason: "refusal" }); model = to; fallbackReason = "refusal"; await sleep(300); }
          if (cmd === "long" && i === Math.floor(parts.length / 2)) break;
          emitted += parts[i]!; send("text_delta", { text: parts[i] }); await sleep(18);
        }
        const [pin, pout] = PRICES[model] ?? [5, 25];
        const usage = { inputTokens: 900 + Math.ceil(text.length / 4), outputTokens: Math.ceil(emitted.length / 4), cacheReadTokens: 620, cacheWriteTokens: 0, estimatedUsd: 0 };
        usage.estimatedUsd = Math.round(((usage.inputTokens * pin + usage.outputTokens * pout) / 1e6) * 1e6) / 1e6;
        const stopReason = cmd === "long" ? "max_tokens" : "end_turn";
        conv.messages.push({ id: userMessageId, role: "user", content: [{ type: "text", text }], model: null, fallbackReason: null, stopReason: null, usage: null, createdAt: now(), ...(attachments.length > 0 ? { attachments } : {}) });
        conv.messages.push({ id: assistantMessageId, role: "assistant", content: [{ type: "text", text: emitted }], model, fallbackReason, stopReason, usage, createdAt: now() });
        conv.messageCount = conv.messages.length; conv.updatedAt = now();
        if (model !== conv.modelId) { conv.pinnedModel = model; conv.pinReason = fallbackReason ?? "availability"; }
        const row = state.usage.find((u) => u.userId === "u-ana" && u.day === today());
        if (row) { row.turns++; row.inputTokens += usage.inputTokens; row.outputTokens += usage.outputTokens; row.estimatedUsd = Math.round((row.estimatedUsd + usage.estimatedUsd) * 1e4) / 1e4; const bm = row.byModel[model] ?? { turns: 0, estimatedUsd: 0 }; bm.turns++; bm.estimatedUsd = Math.round((bm.estimatedUsd + usage.estimatedUsd) * 1e4) / 1e4; row.byModel[model] = bm; }
        state.audit.push({ id: id(), ts: now(), userId: "u-ana", action: "turn", conversationId: conv.id, model: requested, servedBy: model, fallbackReason: fallbackReason ?? undefined, stopReason, usage, latencyMs: 1200 });
        send("done", { assistantMessageId, model, stopReason, usage, fallbackReason });
      } finally { try { controller.close(); } catch { /* ya cerrado */ } }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" } });
}

async function handle(url: URL, init: RequestInit | undefined): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname.replace(/^.*?(?=\/api\/)/, "");
  const body = typeof init?.body === "string" && init.body !== "" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
  await sleep(120);
  if (path === "/api/health") return json({ ok: true, version: "demo" });
  if (path === "/api/auth/dev-login" && method === "POST") { state.loggedIn = true; return json({ ok: true }); }
  if (path === "/api/auth/logout" && method === "POST") { state.loggedIn = false; return json({ logoutUrl: "#/login" }); }
  // Password sign-in is the way in: it must work while signed out.
  if (path === "/api/auth/password/signin" && method === "POST") { const pw = String(body["password"] ?? ""); if (pw === "temp") return json({ challenge: "NEW_PASSWORD_REQUIRED", session: "demo" }); if (pw === "mfa") return json({ challenge: "MFA", session: "demo" }); if (pw === "setup") return json({ challenge: "MFA_SETUP", session: "demo", secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/Helixona%20Assistant:demo%40helixona.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Helixona%20Assistant" }); if (pw.length < 4) return error(401, "invalid_credentials", "Incorrect email or password."); state.loggedIn = true; return json({ ok: true }); }
  if (path === "/api/auth/password/challenge" && method === "POST") { state.loggedIn = true; return json({ ok: true }); }
  if (path === "/api/auth/password/forgot" && method === "POST") return json({ ok: true });
  if (path === "/api/auth/password/reset" && method === "POST") return json({ ok: true });
  if (!state.loggedIn) return error(401, "unauthenticated", "Sign in to continue");
  if (path === "/api/me") return json(me());
  if (path === "/api/conversations" && method === "GET") return json({ items: [...state.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicConv) });
  if (path === "/api/projects" && method === "GET") return json({ items: [...state.projects].sort((a, b) => a.name.localeCompare(b.name)) });
  if (path === "/api/projects" && method === "POST") { const p: Project = { id: id(), ownerId: "u-ana", name: String(body["name"] ?? "New project"), description: String(body["description"] ?? ""), instructions: String(body["instructions"] ?? ""), visibility: body["visibility"] === "clinic" ? "clinic" : "private", knowledge: [], createdAt: now(), updatedAt: now(), canEdit: true }; state.projects.push(p); return json(p, 201); }
  const mProj = path.match(/^\/api\/projects\/([^/]+)(?:\/knowledge(?:\/([^/]+))?)?$/);
  if (mProj) {
    const p = state.projects.find((x) => x.id === mProj[1]);
    if (!p) return error(404, "not_found", "Project not found");
    if (!mProj[2] && path.endsWith("/knowledge") && method === "POST") return json({ id: id(), name: String(body["name"] ?? "file.pdf"), contentType: String(body["contentType"] ?? "application/pdf"), size: Number(body["size"] ?? 0), upload: { url: "mock://upload", method: "PUT", headers: {}, expiresAt: now() } }, 201);
    if (mProj[2] && method === "POST") { const name = String(body["name"] ?? "file.pdf"); p.knowledge.push({ id: mProj[2], name, contentType: name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain", size: 120_000, pages: name.toLowerCase().endsWith(".pdf") ? 8 : null }); p.updatedAt = now(); return json(p); }
    if (mProj[2] && method === "DELETE") { p.knowledge = p.knowledge.filter((k) => k.id !== mProj[2]); p.updatedAt = now(); return json(p); }
    if (method === "GET") return json(p);
    if (method === "PATCH") { Object.assign(p, { name: String(body["name"] ?? p.name), description: String(body["description"] ?? p.description), instructions: String(body["instructions"] ?? p.instructions), visibility: body["visibility"] === "clinic" ? "clinic" : body["visibility"] === "private" ? "private" : p.visibility, updatedAt: now() }); return json(p); }
    if (method === "DELETE") { state.projects = state.projects.filter((x) => x.id !== p.id); state.conversations.forEach((c) => { if (c.projectId === p.id) c.projectId = null; }); return new Response(null, { status: 204 }); }
  }
  if (path === "/api/conversations" && method === "POST") {
    const m = MODELS.find((x) => x.alias === body["modelAlias"]);
    if (!m) return error(400, "unknown_model", "Model not available");
    const f = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const c: Conv = { id: id(), title: `Conversation ${f.format(new Date())}`, modelAlias: m.alias, modelId: m.modelId, pinnedModel: null, pinReason: null, createdAt: now(), updatedAt: now(), messageCount: 0, messages: [], projectId: typeof body["projectId"] === "string" ? String(body["projectId"]) : null };
    state.conversations.push(c);
    return json(publicConv(c), 201);
  }
  const mAtt = path.match(/^\/api\/conversations\/([^/]+)\/attachments$/);
  if (mAtt && method === "POST") return json({ id: id(), name: String(body["name"] ?? "file.pdf"), contentType: String(body["contentType"] ?? "application/pdf"), size: Number(body["size"] ?? 0), upload: { url: "mock://upload", method: "PUT", headers: {}, expiresAt: now() } }, 201);
  const mConv = path.match(/^\/api\/conversations\/([^/]+)(\/messages)?$/);
  if (mConv) {
    const c = state.conversations.find((x) => x.id === mConv[1]);
    if (!c) return error(404, "not_found", "Conversation not found");
    if (mConv[2] && method === "POST") {
      const raw = Array.isArray(body["attachments"]) ? (body["attachments"] as { id: string; name: string }[]) : [];
      const attachments: AttachmentMeta[] = raw.map((a) => ({ id: String(a.id), name: String(a.name), contentType: String(a.name).toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain", size: 245_760, pages: String(a.name).toLowerCase().endsWith(".pdf") ? 12 : null }));
      const text = String(body["text"] ?? "");
      if (!text && attachments.length === 0) return error(400, "bad_request", "Invalid request");
      return sse(c, text || "Please review the attached document.", init?.signal, attachments);
    }
    if (method === "GET") return json({ conversation: publicConv(c), messages: c.messages });
    if (method === "PATCH") { if (typeof body["title"] === "string") c.title = String(body["title"]).slice(0, 80); if (typeof body["modelAlias"] === "string") { const nm = MODELS.find((x) => x.alias === body["modelAlias"]); if (!nm) return error(400, "unknown_model", "Model not available"); c.modelAlias = nm.alias; c.modelId = nm.modelId; c.pinnedModel = null; c.pinReason = null; } c.updatedAt = now(); return json(publicConv(c)); }
    if (method === "DELETE") { state.conversations = state.conversations.filter((x) => x.id !== c.id); return new Response(null, { status: 204 }); }
  }
  if (path === "/api/admin/users" && method === "GET") return json({ items: state.users });
  if (path === "/api/admin/users" && method === "POST") { const u: AdminUser = { id: id(), email: String(body["email"]), name: String(body["name"]), role: body["role"] === "admin" ? "admin" : "staff", enabled: true, createdAt: now() }; state.users.push(u); return json(u, 201); }
  const mRole = path.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
  if (mRole && method === "POST") { const u = state.users.find((x) => x.id === decodeURIComponent(mRole[1]!)); if (u) u.role = body["role"] === "admin" ? "admin" : "staff"; return json({ ok: true }); }
  if (/^\/api\/admin\/users\/[^/]+\/mfa\/reset$/.test(path) && method === "POST") return json({ ok: true });
  if (/^\/api\/admin\/users\/[^/]+\/invitation\/resend$/.test(path) && method === "POST") return json({ ok: true });
  if (/^\/api\/admin\/users\/[^/]+\/temporary-password$/.test(path) && method === "POST") return json({ temporaryPassword: "Demo-Temp-Pass-1!" });
  const mUser = path.match(/^\/api\/admin\/users\/([^/]+)\/(disable|enable)$/);
  if (mUser && method === "POST") { const u = state.users.find((x) => x.id === mUser[1]); if (u) u.enabled = mUser[2] === "enable"; return json({ ok: true }); }
  if (path === "/api/admin/usage") return json({ items: state.usage.filter((u) => u.day === (url.searchParams.get("day") ?? today())) });
  if (path === "/api/admin/audit") return json({ items: state.audit });
  // Workforce training (the signed-in demo user is Ana).
  const quiz = trainingQuiz as { version: string; passingScore: number; questions: { module: number; text: string; options: string[]; answer: string; why: string }[]; modules: { id: number; title: string }[] };
  const trainingInfo = () => ({
    version: quiz.version, passingScore: quiz.passingScore, total: quiz.questions.length,
    questions: quiz.questions.map((q, i) => ({ n: i + 1, module: q.module, text: q.text, options: q.options.map((text, k) => ({ letter: "ABCDEF"[k]!, text })) })),
    modules: quiz.modules.map((m) => ({ id: m.id, title: m.title, questions: quiz.questions.map((q, i) => (q.module === m.id ? i + 1 : 0)).filter(Boolean) })),
    record: state.training,
  });
  // Business associate agreements (the demo administrator can "upload" a copy).
  if (path === "/api/agreements" && method === "GET") return json({ items: AGREEMENTS.map((a) => ({ ...a, file: state.agreements[a.id] ?? { size: a.id === "aws-baa" ? 456589 : 164064, uploadedAt: null, source: "bundled" } })), canDownload: true, uploads: true });
  const mAgr = path.match(/^\/api\/admin\/agreements\/([^/]+)(?:\/(upload|confirm))?$/);
  if (mAgr && method === "POST" && mAgr[2] === "upload") {
    state.agreementSizes[mAgr[1]!] = Number(body["size"] ?? 0);
    return json({ upload: { url: "mock://upload", method: "PUT", headers: {}, expiresAt: now() } });
  }
  if (mAgr && method === "POST" && mAgr[2] === "confirm") {
    state.agreements[mAgr[1]!] = { size: state.agreementSizes[mAgr[1]!] ?? 0, uploadedAt: now(), source: "uploaded" };
    return json({ file: state.agreements[mAgr[1]!] });
  }
  if (mAgr && method === "DELETE" && !mAgr[2]) {
    delete state.agreements[mAgr[1]!];
    return new Response(null, { status: 204 });
  }
  if (path === "/api/training" && method === "GET") return json(trainingInfo());
  const mModule = path.match(/^\/api\/training\/modules\/(\d+)$/);
  if (mModule && method === "POST") {
    const id = Number(mModule[1]);
    const answers = (body["answers"] ?? {}) as Record<string, string>;
    const qs = quiz.questions.map((q, i) => ({ ...q, n: i + 1 })).filter((q) => q.module === id);
    const results = qs.map((q) => (String(answers[String(q.n)] ?? "").toUpperCase() === q.answer ? { n: q.n, correct: true } : { n: q.n, correct: false, why: q.why }));
    const correct = results.filter((r) => r.correct).length;
    const prev = state.training;
    const progress = { ...(prev?.moduleProgress ?? {}) };
    const before = progress[String(id)];
    progress[String(id)] = { attempts: (before?.attempts ?? 0) + 1, firstTryCorrect: before ? before.firstTryCorrect : correct, total: qs.length, completedAt: before?.completedAt ?? (correct === qs.length ? now() : null) };
    const courseComplete = quiz.modules.every((m) => progress[String(m.id)]?.completedAt);
    const score = quiz.modules.reduce((s, m) => s + (progress[String(m.id)]?.firstTryCorrect ?? 0), 0);
    state.training = { userId: "u-ana", name: "Ana Perez", email: "ana@helixona.com", version: quiz.version, attempts: prev?.attempts ?? 0, lastScore: courseComplete ? score : (prev?.lastScore ?? 0), lastAttemptAt: now(), bestScore: courseComplete ? score : (prev?.bestScore ?? 0), passedAt: prev?.passedAt ?? (courseComplete ? now() : null), source: "online", moduleProgress: progress };
    return json({ record: state.training, result: { results, correct, total: qs.length, moduleComplete: correct === qs.length, courseComplete } });
  }
  if (path === "/api/training/check" && method === "POST") {
    const answers = Array.isArray(body["answers"]) ? (body["answers"] as string[]).map((a) => String(a).toUpperCase()) : [];
    if (answers.length !== quiz.questions.length) return error(400, "bad_request", "Answer every question");
    const results = quiz.questions.map((q, i) => (answers[i] === q.answer ? { n: i + 1, correct: true } : { n: i + 1, correct: false, why: q.why }));
    const score = results.filter((r) => r.correct).length;
    const passed = score >= quiz.passingScore;
    const prev = state.training;
    state.training = { userId: "u-ana", name: "Ana Perez", email: "ana@helixona.com", version: quiz.version, attempts: (prev?.attempts ?? 0) + 1, lastScore: score, lastAttemptAt: now(), bestScore: Math.max(prev?.bestScore ?? 0, score), passedAt: prev?.passedAt ?? (passed ? now() : null) };
    return json({ record: state.training, result: { score, total: quiz.questions.length, passed, results } });
  }
  if (path === "/api/training/attest" && method === "POST") {
    state.training = { userId: "u-ana", name: "Ana Perez", email: "ana@helixona.com", version: quiz.version, attempts: state.training?.attempts ?? 0, lastScore: state.training?.lastScore ?? 0, lastAttemptAt: state.training?.lastAttemptAt ?? now(), bestScore: state.training?.bestScore ?? 0, passedAt: state.training?.passedAt ?? now(), source: "attested" };
    return json({ record: state.training });
  }
  if (path === "/api/admin/training" && method === "GET") return json({ items: state.users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, enabled: u.enabled, inDirectory: true, record: u.id === "u-ana" ? state.training : null })), version: quiz.version, passingScore: quiz.passingScore, total: quiz.questions.length });
  const mPaper = path.match(/^\/api\/admin\/training\/([^/]+)\/paper$/);
  if (mPaper && method === "POST") {
    const u = state.users.find((x) => x.id === decodeURIComponent(mPaper[1]!));
    if (!u) return error(404, "not_found", "User not found");
    const at = `${String(body["completedAt"])}T12:00:00.000Z`;
    const record: TrainingRecord = { userId: u.id, name: u.name, email: u.email, version: quiz.version, attempts: 0, lastScore: Number(body["score"]), lastAttemptAt: at, bestScore: Number(body["score"]), passedAt: at, source: "paper" };
    if (u.id === "u-ana") state.training = record;
    return json({ record });
  }
  return error(404, "not_found", "Resource not found");
}

export function installMockApi(): void {
  seed();
  const realFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    if (!url.pathname.includes("/api/")) return realFetch(input, init);
    return handle(url, init);
  };
  const banner = document.createElement("div");
  banner.className = "demo-banner";
  banner.setAttribute("role", "note");
  banner.textContent = "Preview with sample data · not connected to Bedrock or Cognito";
  document.body.prepend(banner);
}
