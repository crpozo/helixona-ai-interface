/**
 * API simulada para la vista previa publicada (modo `demo`): intercepta `fetch` a `/api/*`
 * y responde en memoria, incluido el streaming SSE. Datos de ejemplo, sin Bedrock ni PHI real.
 */
import type { AdminUser, AuditEvent, Conversation, Me, Message, UsageRow } from "../lib/types";

const MODELS = [
  { alias: "sonnet", modelId: "anthropic.claude-sonnet-5", label: "Sonnet", description: "Rápido y económico: traducciones, cartas, resúmenes cortos", costFactor: 1, available: true },
  { alias: "opus", modelId: "anthropic.claude-opus-5", label: "Opus", description: "Equilibrio recomendado para el trabajo diario", costFactor: 2.5, available: true },
  { alias: "fable", modelId: "anthropic.claude-fable-5-1", label: "Fable", description: "Máxima capacidad para tareas difíciles y documentos largos (más lento y costoso)", costFactor: 5, available: true },
  { alias: "anthropic.claude-opus-4-8", modelId: "anthropic.claude-opus-4-8", label: "Opus 4.8", description: "Solo como respaldo", costFactor: 0, available: false },
];
const PRICES: Record<string, [number, number]> = { "anthropic.claude-sonnet-5": [2, 10], "anthropic.claude-opus-5": [5, 25], "anthropic.claude-fable-5-1": [10, 50], "anthropic.claude-opus-4-8": [5, 25] };
const FALLBACK: Record<string, string | undefined> = { "anthropic.claude-fable-5-1": "anthropic.claude-opus-5", "anthropic.claude-opus-5": "anthropic.claude-opus-4-8" };

let seq = 100;
const id = () => `demo${(seq++).toString(36).padStart(6, "0")}`;
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Conv extends Conversation { messages: Message[] }
const state = {
  loggedIn: true,
  conversations: [] as Conv[],
  users: [
    { id: "u-ana", email: "ana@helixona.com", name: "Ana Pérez", role: "admin", enabled: true, createdAt: "2026-09-01T14:00:00Z" },
    { id: "u-luis", email: "luis@helixona.com", name: "Luis Romero", role: "staff", enabled: true, createdAt: "2026-09-02T15:30:00Z" },
    { id: "u-marta", email: "marta@helixona.com", name: "Marta Gil", role: "staff", enabled: false, createdAt: "2026-09-03T09:10:00Z" },
  ] as AdminUser[],
  usage: [] as UsageRow[],
  audit: [] as AuditEvent[],
};

function seed() {
  const c1: Conv = {
    id: id(), title: "Ejemplo · carta de recordatorio", modelAlias: "opus", modelId: "anthropic.claude-opus-5", pinnedModel: null, pinReason: null,
    createdAt: "2026-09-12T14:02:00Z", updatedAt: "2026-09-12T14:05:00Z", messageCount: 2, messages: [],
  };
  c1.messages.push(
    { id: id(), role: "user", content: [{ type: "text", text: "Redacta una carta breve para recordar a un paciente su cita de seguimiento del próximo martes a las 10:00 y pedirle que traiga sus últimos análisis." }], model: null, fallbackReason: null, stopReason: null, usage: null, createdAt: "2026-09-12T14:02:10Z" },
    { id: id(), role: "assistant", content: [{ type: "text", text: "**Asunto: Recordatorio de cita de seguimiento**\n\nEstimado/a paciente:\n\nLe recordamos que tiene una cita de seguimiento el **martes a las 10:00** en nuestra clínica. Le pedimos que traiga sus **últimos análisis de laboratorio** para revisarlos durante la consulta.\n\nSi necesita cambiar la fecha, puede llamarnos y con gusto le ayudaremos.\n\nAtentamente,\nEquipo de Helixona\n\n---\n*Revisa el nombre del paciente y la fecha antes de enviar.*" }], model: "anthropic.claude-opus-5", fallbackReason: null, stopReason: "end_turn", usage: { inputTokens: 812, outputTokens: 190, cacheReadTokens: 640, cacheWriteTokens: 0, estimatedUsd: 0.0089 }, createdAt: "2026-09-12T14:02:24Z" },
  );
  const c2: Conv = {
    id: id(), title: "Ejemplo · traducción ES/EN", modelAlias: "sonnet", modelId: "anthropic.claude-sonnet-5", pinnedModel: null, pinReason: null,
    createdAt: "2026-09-11T20:40:00Z", updatedAt: "2026-09-11T20:41:00Z", messageCount: 2, messages: [],
  };
  c2.messages.push(
    { id: id(), role: "user", content: [{ type: "text", text: "Traduce al inglés: \"Tome el medicamento con alimentos, una vez al día, durante 14 días. Si presenta mareos, suspenda y contacte a la clínica.\"" }], model: null, fallbackReason: null, stopReason: null, usage: null, createdAt: "2026-09-11T20:40:05Z" },
    { id: id(), role: "assistant", content: [{ type: "text", text: "\"Take the medication with food, once a day, for 14 days. If you experience dizziness, stop taking it and contact the clinic.\"" }], model: "anthropic.claude-sonnet-5", fallbackReason: null, stopReason: "end_turn", usage: { inputTokens: 740, outputTokens: 42, cacheReadTokens: 600, cacheWriteTokens: 0, estimatedUsd: 0.0007 }, createdAt: "2026-09-11T20:40:09Z" },
  );
  state.conversations.push(c1, c2);
  state.usage.push({ userId: "u-ana", day: today(), turns: 14, inputTokens: 21040, outputTokens: 5120, estimatedUsd: 0.31, byModel: { "anthropic.claude-opus-5": { turns: 9, estimatedUsd: 0.22 }, "anthropic.claude-sonnet-5": { turns: 5, estimatedUsd: 0.09 } } });
  state.usage.push({ userId: "u-luis", day: today(), turns: 6, inputTokens: 9800, outputTokens: 2400, estimatedUsd: 0.41, byModel: { "anthropic.claude-fable-5-1": { turns: 6, estimatedUsd: 0.41 } } });
}
function today() { return now().slice(0, 10); }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function error(status: number, code: string, message: string): Response { return json({ error: { code, message } }, status); }

function me(): Me {
  return {
    user: { id: "u-ana", email: "ana@helixona.com", name: "Ana Pérez", roles: ["staff", "admin"] },
    session: { expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(), idleTimeoutSeconds: 900 },
    catalog: { defaultAlias: "opus", effort: "medium", models: MODELS },
    limits: { maxMessageChars: 20000, contextLimitTokens: 150000 },
  };
}

function publicConv(c: Conv): Conversation { const { messages: _m, ...rest } = c; return rest; }

function reply(userText: string, model: string): string {
  const t = userText.replace(/^\/\S+\s*/, "").trim();
  const label = MODELS.find((m) => m.modelId === model)?.label ?? model;
  if (/traduc/i.test(t)) return `**Traducción**\n\n"${t.replace(/^traduce (al inglés|al español)?:?\s*/i, "").replace(/^"|"$/g, "")}"\n\n*(Respuesta de ejemplo generada por la vista previa, modelo ${label}.)*`;
  if (/carta|correo|mensaje/i.test(t)) return `**Borrador**\n\nEstimado/a paciente:\n\n${t.length > 20 ? "Le escribimos en relación con su solicitud. " : ""}Quedamos a su disposición para cualquier consulta.\n\nAtentamente,\nEquipo de Helixona\n\n---\n*Revisa los datos antes de enviar. Respuesta de ejemplo (${label}).*`;
  if (/resum/i.test(t)) return `**Resumen**\n\n- Punto principal del texto recibido.\n- Segundo punto relevante.\n- Acción sugerida para el equipo.\n\n*Respuesta de ejemplo (${label}).*`;
  return `Esta es una **vista previa** de la interfaz: no hay conexión con Bedrock y las respuestas son de ejemplo.\n\nRecibí tu mensaje (${t.length} caracteres) y lo habría procesado con **${label}** a esfuerzo \`medium\`.\n\nPrueba escribiendo al inicio del mensaje:\n\n- \`/refuse\` para ver un rechazo del clasificador con continuación en el modelo de respaldo\n- \`/refuse-all\` para ver un rechazo de toda la cadena\n- \`/throttle\` para ver un cambio por indisponibilidad\n- \`/long\` para ver una respuesta truncada`;
}

function sse(conv: Conv, text: string, signal: AbortSignal | null | undefined): Response {
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
          if (!to) { send("error", { code: "model_unavailable", message: "El modelo no está disponible en este momento", retryable: true, partial: false }); controller.close(); return; }
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
        conv.messages.push({ id: userMessageId, role: "user", content: [{ type: "text", text }], model: null, fallbackReason: null, stopReason: null, usage: null, createdAt: now() });
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
  if (!state.loggedIn) return error(401, "unauthenticated", "Inicia sesión para continuar");
  if (path === "/api/me") return json(me());
  if (path === "/api/conversations" && method === "GET") return json({ items: [...state.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicConv) });
  if (path === "/api/conversations" && method === "POST") {
    const m = MODELS.find((x) => x.alias === body["modelAlias"]);
    if (!m) return error(400, "unknown_model", "Modelo no disponible");
    const f = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const c: Conv = { id: id(), title: `Conversación ${f.format(new Date())}`, modelAlias: m.alias, modelId: m.modelId, pinnedModel: null, pinReason: null, createdAt: now(), updatedAt: now(), messageCount: 0, messages: [] };
    state.conversations.push(c);
    return json(publicConv(c), 201);
  }
  const mConv = path.match(/^\/api\/conversations\/([^/]+)(\/messages)?$/);
  if (mConv) {
    const c = state.conversations.find((x) => x.id === mConv[1]);
    if (!c) return error(404, "not_found", "Conversación no encontrada");
    if (mConv[2] && method === "POST") { const text = String(body["text"] ?? ""); if (!text) return error(400, "bad_request", "Solicitud inválida"); return sse(c, text, init?.signal); }
    if (method === "GET") return json({ conversation: publicConv(c), messages: c.messages });
    if (method === "PATCH") { c.title = String(body["title"] ?? c.title).slice(0, 80); c.updatedAt = now(); return json(publicConv(c)); }
    if (method === "DELETE") { state.conversations = state.conversations.filter((x) => x.id !== c.id); return new Response(null, { status: 204 }); }
  }
  if (path === "/api/admin/users" && method === "GET") return json({ items: state.users });
  if (path === "/api/admin/users" && method === "POST") { const u: AdminUser = { id: id(), email: String(body["email"]), name: String(body["name"]), role: body["role"] === "admin" ? "admin" : "staff", enabled: true, createdAt: now() }; state.users.push(u); return json(u, 201); }
  const mUser = path.match(/^\/api\/admin\/users\/([^/]+)\/(disable|enable)$/);
  if (mUser && method === "POST") { const u = state.users.find((x) => x.id === mUser[1]); if (u) u.enabled = mUser[2] === "enable"; return json({ ok: true }); }
  if (path === "/api/admin/usage") return json({ items: state.usage.filter((u) => u.day === (url.searchParams.get("day") ?? today())) });
  if (path === "/api/admin/audit") return json({ items: state.audit });
  return error(404, "not_found", "Recurso no encontrado");
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
  banner.textContent = "Vista previa con datos de ejemplo · sin conexión a Bedrock ni a Cognito";
  document.body.prepend(banner);
}
