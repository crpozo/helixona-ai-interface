import { APIError, APIConnectionError, APIUserAbortError } from "@anthropic-ai/sdk";
import type { BetaMessage, BetaRawMessageStreamEvent, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { noopLogger, type SafeLogger } from "../logger.js";
import type { LlmProvider, StreamHandle, StreamParams } from "./provider.js";

/**
 * OpenAI models behind the same interface as the Claude ones. The rest of the application speaks the
 * Messages API shape (blocks, tool_use / tool_result, stream events); this provider translates a
 * request into OpenAI's Responses API and the answer back, so the router, the tools and the stored
 * history do not know which vendor answered.
 *
 * The API is called over plain HTTPS (`POST …/responses`, server-sent events): OpenAI's SDK pulls
 * in dependencies that clash with the AWS SDK's, and this needs one endpoint. Two ways in:
 *  - Amazon Bedrock's OpenAI-compatible endpoint (`bedrock-runtime…/openai/v1`), signed with the
 *    task's AWS credentials: the models run inside AWS, under the clinic's AWS agreement. Preferred.
 *  - OpenAI's own API with an organization key, which needs the clinic's own agreement with OpenAI.
 *
 * Catalog ids carry the `openai.` prefix (`openai.gpt-6-astra`); the API takes the bare id.
 * Requests are sent with `store: false`: nothing is kept as application state at OpenAI.
 * Reasoning is not carried between requests (the encrypted items would have to live in the stored
 * history, which Claude models also read), so each tool round reasons from the visible conversation.
 */
export const OPENAI_PREFIX = "openai.";

export function isOpenAiModel(modelId: string): boolean {
  return modelId.startsWith(OPENAI_PREFIX);
}

type Block = Record<string, unknown> & { type: string };

/** The parts of the Responses API this provider uses (field names as in OpenAI's reference). */
export type ResponseInputItem = Record<string, unknown>;
export interface ResponsesBody {
  model: string;
  stream: true;
  store: false;
  instructions?: string;
  input: ResponseInputItem[];
  max_output_tokens: number;
  reasoning: { effort: string };
  tools?: Array<{ type: "function"; name: string; description: string; parameters: Record<string, unknown>; strict: boolean }>;
  parallel_tool_calls?: boolean;
  prompt_cache_key?: string;
}
interface FunctionCallItem { type: string; id?: string; call_id: string; name: string; arguments?: string }
interface ResponseObject {
  id: string;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | null;
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string | null; message?: string } | null;
}
type StreamEvent =
  | { type: "response.output_text.delta"; delta: string }
  | { type: "response.refusal.delta"; delta: string }
  | { type: "response.output_item.added" | "response.output_item.done"; item: FunctionCallItem }
  | { type: "response.function_call_arguments.delta"; item_id: string; delta: string }
  | { type: "response.completed" | "response.incomplete" | "response.failed"; response: ResponseObject }
  | { type: "error"; code?: string | null; message?: string };

/** Posts the body and yields the stream's events. Replaceable in tests. */
export type ResponsesTransport = (body: ResponsesBody, signal: AbortSignal) => AsyncIterable<StreamEvent>;

class HttpStatusError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`openai http ${status}`);
  }
}

/** OpenAI's own endpoint, with the organization's API key. */
export function httpTransport(apiKey: string, timeoutMs: number, baseUrl = "https://api.openai.com/v1", fetchImpl: typeof fetch = fetch): ResponsesTransport {
  return sseTransport({ url: `${baseUrl}/responses`, timeoutMs, fetchImpl, headers: async () => ({ authorization: `Bearer ${apiKey}` }) });
}

export interface SseTransportOptions {
  /** The Responses endpoint (`…/responses`). */
  url: string;
  timeoutMs: number;
  /** Authentication headers for this exact body (a bearer key, or a request signature). */
  headers: (url: string, body: string) => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
}

/** `POST …/responses` with `stream: true`, parsed from server-sent events. */
export function sseTransport(opts: SseTransportOptions): ResponsesTransport {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async function* (body, signal) {
    const timeout = AbortSignal.timeout(opts.timeoutMs);
    const payload = JSON.stringify(body);
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...(await opts.headers(opts.url, payload)) },
      body: payload,
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!res.ok || !res.body) {
      // Only the error code is read: the provider's message may quote the request.
      let code = "";
      try {
        // The code and the name of the offending field only; never the message, which may quote the request.
        const parsed = (await res.json()) as { error?: { code?: string | null; type?: string; param?: string | null }; __type?: string; code?: string };
        const param = parsed.error?.param ? `:${String(parsed.error.param)}` : "";
        code = `${String(parsed.error?.code ?? parsed.error?.type ?? parsed.__type ?? parsed.code ?? res.headers.get("x-amzn-errortype") ?? "")}${param}`.replace(/[^\w.:\-\[\]]/g, "_").slice(0, 80);
      } catch {
        /* no JSON body */
      }
      throw new HttpStatusError(res.status, code);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      for (let cut = buffer.search(/\r?\n\r?\n/); cut >= 0; cut = buffer.search(/\r?\n\r?\n/)) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
        const data = frame.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as StreamEvent;
        } catch {
          /* a frame that is not JSON (a comment or keep-alive) */
        }
      }
    }
  };
}
type InputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" } | { type: "input_file"; filename: string; file_data: string };

function blocksOf(content: BetaMessageParam["content"]): Block[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : (content as unknown as Block[]);
}

/** A document, image or text block as OpenAI input content; null for blocks with no equivalent. */
function inputContent(b: Block): InputContent | null {
  if (b.type === "text") return typeof b.text === "string" && b.text ? { type: "input_text", text: b.text } : null;
  const source = (b.source ?? {}) as { type?: string; media_type?: string; data?: string; url?: string };
  if (b.type === "image") {
    if (source.type === "base64" && source.data) return { type: "input_image", image_url: `data:${source.media_type ?? "image/png"};base64,${source.data}`, detail: "auto" };
    if (source.type === "url" && source.url) return { type: "input_image", image_url: source.url, detail: "auto" };
    return null;
  }
  if (b.type === "document") {
    const title = typeof b.title === "string" && b.title ? b.title : "document";
    if (source.type === "base64" && source.data) return { type: "input_file", filename: /\.pdf$/i.test(title) ? title : `${title}.pdf`, file_data: `data:${source.media_type ?? "application/pdf"};base64,${source.data}` };
    if (source.type === "text" && typeof source.data === "string") {
      const context = typeof b.context === "string" && b.context ? `${b.context}\n` : "";
      return { type: "input_text", text: `<document title="${title.replace(/"/g, "'")}">\n${context}${source.data}\n</document>` };
    }
  }
  return null;
}

/** What a tool returned, as the function call's output: text, or text with the files and images it read. */
function toolOutput(b: Block): string | InputContent[] {
  const prefix = b.is_error ? "Error: " : "";
  if (typeof b.content === "string") return prefix + b.content;
  const parts = (Array.isArray(b.content) ? (b.content as Block[]) : []).map(inputContent).filter((p): p is InputContent => p !== null);
  if (parts.every((p) => p.type === "input_text")) return prefix + parts.map((p) => (p as { text: string }).text).join("\n");
  return prefix ? [{ type: "input_text", text: prefix.trim() }, ...parts] : parts;
}

/** The conversation in Messages API shape as Responses API input items, in the same order. */
export function toResponsesInput(messages: BetaMessageParam[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const m of messages) {
    const blocks = blocksOf(m.content);
    if (m.role === "assistant") {
      // Text first, then the calls: thinking, fallback markers and other vendor-specific blocks are left out.
      const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string" && b.text).map((b) => b.text as string).join("\n\n");
      if (text) out.push({ role: "assistant", content: text } as ResponseInputItem);
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        out.push({ type: "function_call", call_id: String(b.id), name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } as ResponseInputItem);
      }
      continue;
    }
    // A mid-conversation operator instruction, or a user turn: tool results are items of their own.
    const content: InputContent[] = [];
    const flush = () => {
      if (content.length === 0) return;
      out.push({ role: (m.role as string) === "system" ? "developer" : "user", content: content.splice(0) } as ResponseInputItem);
    };
    for (const b of blocks) {
      if (b.type === "tool_result") {
        flush();
        out.push({ type: "function_call_output", call_id: String(b.tool_use_id), output: toolOutput(b) } as ResponseInputItem);
        continue;
      }
      const c = inputContent(b);
      if (c) content.push(c);
    }
    flush();
  }
  return out;
}

/** The request body for one round. */
export function buildResponsesBody(params: StreamParams, _conversationId?: string, wireModel: (catalogId: string) => string = (id) => id.slice(OPENAI_PREFIX.length)): ResponsesBody {
  const instructions = params.system.map((b) => b.text).filter(Boolean).join("\n\n");
  const tools = (params.tools ?? []).flatMap((t) => {
    const tool = t as { name?: string; description?: string; input_schema?: Record<string, unknown> };
    // Only tools defined by the application (name + JSON schema) have an equivalent.
    if (!tool.name || !tool.input_schema) return [];
    return [{ type: "function" as const, name: tool.name, description: tool.description ?? "", parameters: tool.input_schema, strict: false }];
  });
  return {
    model: wireModel(params.model),
    stream: true,
    store: false,
    ...(instructions ? { instructions } : {}),
    input: toResponsesInput(params.messages),
    max_output_tokens: params.maxTokens,
    reasoning: { effort: params.effort },
    // Only what every Responses endpoint takes (OpenAI's own and Amazon Bedrock's): no optional
    // tuning fields, which a compatible endpoint may reject. Parallel tool calls are the default.
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/** An OpenAI failure as the error class the rest of the application classifies (status and a safe message). */
function translateError(e: unknown): unknown {
  if (e instanceof HttpStatusError) {
    // The account is out of credit: every model fails the same way, the people who run it must act.
    if (e.code === "insufficient_quota" || e.code === "billing_hard_limit_reached") return APIError.generate(400, undefined, "billing: the OpenAI account has no credit left or its billing is blocked", new Headers());
    // Bedrock answers 401 `access_denied` when the role is recognized but not allowed: a permission, not a key.
    if (/access_?denied/i.test(e.code)) return APIError.generate(403, undefined, `openai: access denied: the role lacks permission or the model is not enabled (${e.code})`, new Headers());
    const about = /AccessDenied/i.test(e.code) ? "access denied: the model is not enabled for this account or the role lacks permission" : /Throttling/i.test(e.code) ? "rate limit" : e.code === "model_not_found" || e.status === 404 ? "model does not exist or is not enabled for this organization" : e.status === 401 ? "invalid API key" : e.status === 403 ? "permission denied" : e.status === 429 ? "rate limit" : e.status >= 500 ? "server error" : "invalid request";
    return APIError.generate(e.status, undefined, `openai: ${about}${e.code ? ` (${e.code})` : ""}`, new Headers());
  }
  if (e instanceof APIError) return e;
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return e.name === "TimeoutError" ? new APIConnectionError({ message: "timeout" }) : new APIUserAbortError();
  if (e instanceof TypeError) return new APIConnectionError({ message: "connection error" }); // fetch: DNS, TLS, reset
  return e;
}

function failure(code: string | null | undefined, message: string | undefined): unknown {
  const c = String(code ?? "");
  if (c === "insufficient_quota") return APIError.generate(400, undefined, "billing: the OpenAI account has no credit left or its billing is blocked", new Headers());
  const status = c === "rate_limit_exceeded" ? 429 : c === "invalid_prompt" || /invalid/i.test(c) ? 400 : 500;
  void message; // the provider's own text is never kept: codes only
  return APIError.generate(status, undefined, `openai: ${status === 429 ? "rate limit" : status === 400 ? "invalid request" : "server error"}${c ? ` (${c})` : ""}`, new Headers());
}

export interface OpenAiProviderOptions {
  /** OpenAI's API key; not needed when a `transport` is given (Amazon Bedrock signs with the task role). */
  apiKey?: string;
  /** The model id on the wire for a catalog id. Default: the id without `openai.` (OpenAI's own API). */
  wireModel?: (catalogId: string) => string;
  timeoutMs?: number;
  logger?: SafeLogger;
  /** For tests: what posts the body and yields the events. */
  transport?: ResponsesTransport;
}

export class OpenAiProvider implements LlmProvider {
  private readonly transport: ResponsesTransport;
  private readonly log: SafeLogger;
  private readonly wireModel: ((catalogId: string) => string) | undefined;

  constructor(opts: OpenAiProviderOptions) {
    this.log = opts.logger ?? noopLogger;
    if (!opts.transport && !opts.apiKey) throw new Error("openai: an API key or a transport is required");
    this.transport = opts.transport ?? httpTransport(opts.apiKey!, opts.timeoutMs ?? 600_000);
    this.wireModel = opts.wireModel;
  }

  stream(params: StreamParams, opts: { signal: AbortSignal; conversationId: string }): StreamHandle {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    const body = buildResponsesBody(params, opts.conversationId, this.wireModel);
    const transport = this.transport;
    const log = this.log;
    let resolveFinal!: (m: BetaMessage) => void;
    let rejectFinal!: (e: unknown) => void;
    const final = new Promise<BetaMessage>((res, rej) => {
      resolveFinal = res;
      rejectFinal = rej;
    });
    final.catch(() => undefined); // read through finalMessage(); an unread rejection must not crash the process

    async function* run(): AsyncGenerator<BetaRawMessageStreamEvent> {
      let text = "";
      let refusal = "";
      const calls = new Map<string, { call_id: string; name: string; arguments: string }>();
      let done: ResponseObject | null = null;
      try {
        const events = transport(body, controller.signal);
        let started = false;
        const start = { type: "message_start", message: { id: "", type: "message", role: "assistant", model: params.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } as unknown as BetaRawMessageStreamEvent;
        for await (const ev of events) {
          if (!started) {
            started = true;
            yield start;
          }
          switch (ev.type) {
            case "response.output_text.delta":
              text += ev.delta;
              yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ev.delta } } as BetaRawMessageStreamEvent;
              break;
            case "response.refusal.delta":
              refusal += ev.delta;
              break;
            case "response.output_item.added":
              if (ev.item.type === "function_call") calls.set(ev.item.id ?? ev.item.call_id, { call_id: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments ?? "" });
              break;
            case "response.function_call_arguments.delta": {
              const c = calls.get(ev.item_id);
              if (c) c.arguments += ev.delta;
              break;
            }
            case "response.output_item.done":
              // The finished item carries the whole call: it wins over what the deltas added up to.
              if (ev.item.type === "function_call") calls.set(ev.item.id ?? ev.item.call_id, { call_id: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments ?? "" });
              break;
            case "response.completed":
            case "response.incomplete":
              done = ev.response;
              break;
            case "response.failed":
              throw failure(ev.response.error?.code, ev.response.error?.message);
            case "error":
              throw failure(ev.code, ev.message);
            default:
              break;
          }
        }
        if (!done) throw failure("server_error", "stream ended without a response");

        const u = done.usage;
        const cached = u?.input_tokens_details?.cached_tokens ?? 0;
        const content: Array<Record<string, unknown>> = [];
        if (text) content.push({ type: "text", text, citations: null });
        for (const c of calls.values()) {
          let input: unknown = {};
          try {
            input = c.arguments ? JSON.parse(c.arguments) : {};
          } catch {
            log.warn("openai_tool_arguments_invalid", { model: params.model, action: c.name });
          }
          content.push({ type: "tool_use", id: c.call_id, name: c.name, input });
        }
        const incomplete = done.incomplete_details?.reason ?? null;
        const refused = (refusal.length > 0 && !text) || incomplete === "content_filter";
        const stop = refused ? "refusal" : calls.size > 0 ? "tool_use" : incomplete === "max_output_tokens" ? "max_tokens" : "end_turn";
        resolveFinal({
          id: done.id,
          type: "message",
          role: "assistant",
          model: params.model,
          content: refused ? [] : content,
          stop_reason: stop,
          stop_sequence: null,
          ...(refused ? { stop_details: { type: "refusal", category: null, explanation: null } } : {}),
          // OpenAI counts cached tokens inside input_tokens; the application keeps them apart.
          usage: { input_tokens: Math.max(0, (u?.input_tokens ?? 0) - cached), output_tokens: u?.output_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 },
        } as unknown as BetaMessage);
      } catch (e) {
        const err = controller.signal.aborted ? new APIUserAbortError() : translateError(e);
        rejectFinal(err);
        throw err;
      } finally {
        opts.signal.removeEventListener("abort", onAbort);
      }
    }

    const iterator = run();
    return {
      [Symbol.asyncIterator]: () => iterator,
      finalMessage: () => final,
      abort: () => controller.abort(),
    };
  }
}

/** Sends each request to the provider of its model: `openai.` ids to OpenAI, the rest to Claude. */
export class RoutedProvider implements LlmProvider {
  constructor(private readonly claude: LlmProvider, private readonly openai: LlmProvider | null) {}

  stream(params: StreamParams, opts: { signal: AbortSignal; conversationId: string }): StreamHandle {
    if (isOpenAiModel(params.model)) {
      if (!this.openai) throw APIError.generate(404, undefined, "openai: model is not enabled on this server", new Headers());
      return this.openai.stream(params, opts);
    }
    return this.claude.stream(params, opts);
  }
}
