import { describe, expect, it } from "vitest";
import { APIError } from "@anthropic-ai/sdk";
import { DEFAULT_CATALOG, OPENAI_MODELS, estimateUsd, labelFor, withOpenAi } from "../src/catalog.js";
import { classifyError } from "../src/errors.js";
import { OpenAiProvider, RoutedProvider, buildResponsesBody, httpTransport, toResponsesInput, type ResponsesBody, type ResponsesTransport } from "../src/llm/openai-provider.js";
import type { StreamParams } from "../src/llm/provider.js";

const params = (over: Partial<StreamParams> = {}): StreamParams => ({
  model: "openai.gpt-6.1-sol",
  maxTokens: 64000,
  effort: "medium",
  system: [{ type: "text", text: "You are the clinic's assistant." }, { type: "text", text: "# Project: Appeals" }],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  ...over,
});

async function drain(provider: OpenAiProvider, p: StreamParams) {
  const stream = provider.stream(p, { signal: new AbortController().signal, conversationId: "01CONV" });
  const events: Array<{ type: string }> = [];
  for await (const ev of stream) events.push(ev);
  return { events, final: await stream.finalMessage() };
}

describe("OpenAI catalog", () => {
  it("joins the Claude models only through withOpenAi, with its own prices and fallbacks inside OpenAI", () => {
    expect(DEFAULT_CATALOG.models.some((m) => m.modelId.startsWith("openai."))).toBe(false);
    const c = withOpenAi(DEFAULT_CATALOG);
    expect(c.defaultAlias).toBe(DEFAULT_CATALOG.defaultAlias);
    expect(c.models.map((m) => m.alias)).toEqual(["haiku", "sonnet", "opus", "fable", "gpt-luna", "gpt-terra", "gpt-sol", "gpt-astra"]);
    expect(labelFor(c, "openai.gpt-6-astra")).toBe("GPT-6 Astra");
    expect(estimateUsd(c, "openai.gpt-6-astra", { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 })).toBe(61);
    for (const m of OPENAI_MODELS) expect([...m.refusalFallbacks, ...m.availabilityFallbacks].every((id) => id.startsWith("openai."))).toBe(true);
    expect(withOpenAi(c).models).toHaveLength(8); // applying it twice adds nothing
  });
});

describe("OpenAI request", () => {
  it("translates the conversation: instructions, files, images, tool calls and their results, in order", () => {
    const body = buildResponsesBody(
      params({
        effort: "high",
        tools: [{ name: "read_zip_files", description: "Reads files", input_schema: { type: "object", properties: { paths: { type: "array" } } } }] as never,
        messages: [
          {
            role: "user",
            content: [
              { type: "document", title: "EOB March.pdf", source: { type: "base64", media_type: "application/pdf", data: "UERG" }, cache_control: { type: "ephemeral" } },
              { type: "document", title: "Notes.txt", context: "Read on request.", source: { type: "text", media_type: "text/plain", data: "line one" } },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "UE5H" } },
              { type: "text", text: "Summarize these" },
            ],
          },
          { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Let me read the files first." }, { type: "tool_use", id: "toolu_1", name: "read_zip_files", input: { paths: ["a.csv"] } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Patient,Amount" }] }, { type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "No such file" }] },
          { role: "assistant", content: [{ type: "text", text: "Ana was paid $10." }] },
          { role: "user", content: "And the total?" },
        ] as never,
      }),
      "01CONV",
    );
    expect(body).toMatchObject({ model: "gpt-6.1-sol", stream: true, store: false, max_output_tokens: 64000, reasoning: { effort: "high" }, prompt_cache_key: "01CONV", instructions: "You are the clinic's assistant.\n\n# Project: Appeals" });
    expect(body.tools).toEqual([{ type: "function", name: "read_zip_files", description: "Reads files", parameters: { type: "object", properties: { paths: { type: "array" } } }, strict: false }]);
    expect(body.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_file", filename: "EOB March.pdf", file_data: "data:application/pdf;base64,UERG" },
          { type: "input_text", text: '<document title="Notes.txt">\nRead on request.\nline one\n</document>' },
          { type: "input_image", image_url: "data:image/png;base64,UE5H", detail: "auto" },
          { type: "input_text", text: "Summarize these" },
        ],
      },
      { role: "assistant", content: "Let me read the files first." },
      { type: "function_call", call_id: "toolu_1", name: "read_zip_files", arguments: '{"paths":["a.csv"]}' },
      { type: "function_call_output", call_id: "toolu_1", output: "Patient,Amount" },
      { type: "function_call_output", call_id: "toolu_2", output: "Error: No such file" },
      { role: "assistant", content: "Ana was paid $10." },
      { role: "user", content: [{ type: "input_text", text: "And the total?" }] },
    ]);
    // A tool that returned a file: the output carries it as content.
    expect(toResponsesInput([{ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "p.pdf" }, { type: "document", title: "p.pdf", source: { type: "base64", media_type: "application/pdf", data: "UERG" } }] }] }] as never)).toEqual([
      { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "p.pdf" }, { type: "input_file", filename: "p.pdf", file_data: "data:application/pdf;base64,UERG" }] },
    ]);
  });
});

describe("OpenAI stream", () => {
  const transport = (events: unknown[], seen?: ResponsesBody[]): ResponsesTransport =>
    async function* (body) {
      seen?.push(body);
      for (const e of events) yield e as never;
    };

  it("streams text and reports usage with cached tokens kept apart", async () => {
    const seen: ResponsesBody[] = [];
    const provider = new OpenAiProvider({ apiKey: "k", transport: transport([
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Hello " },
      { type: "response.output_text.delta", delta: "there" },
      { type: "response.completed", response: { id: "resp_1", usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 800 } } } },
    ], seen) });
    const { events, final } = await drain(provider, params());
    expect(events.map((e) => e.type)).toEqual(["message_start", "content_block_delta", "content_block_delta"]);
    expect((events[0] as unknown as { message: { model: string } }).message.model).toBe("openai.gpt-6.1-sol");
    expect(final).toMatchObject({ model: "openai.gpt-6.1-sol", stop_reason: "end_turn", content: [{ type: "text", text: "Hello there" }], usage: { input_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0, output_tokens: 20 } });
    expect(seen[0]!.model).toBe("gpt-6.1-sol");
  });

  it("a function call becomes a tool_use block and stops the round for tools; truncation and refusals are named", async () => {
    const call = new OpenAiProvider({ apiKey: "k", transport: transport([
      { type: "response.output_text.delta", delta: "Let me read." },
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read_zip_files", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"paths":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '["a.csv"]}' },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read_zip_files", arguments: '{"paths":["a.csv"]}' } },
      { type: "response.completed", response: { id: "resp_2", usage: { input_tokens: 10, output_tokens: 5 } } },
    ]) });
    expect((await drain(call, params())).final).toMatchObject({ stop_reason: "tool_use", content: [{ type: "text", text: "Let me read." }, { type: "tool_use", id: "call_9", name: "read_zip_files", input: { paths: ["a.csv"] } }] });

    const cut = new OpenAiProvider({ apiKey: "k", transport: transport([{ type: "response.output_text.delta", delta: "Part" }, { type: "response.incomplete", response: { id: "r", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 1, output_tokens: 1 } } }]) });
    expect((await drain(cut, params())).final.stop_reason).toBe("max_tokens");

    const refused = new OpenAiProvider({ apiKey: "k", transport: transport([{ type: "response.refusal.delta", delta: "I can't help with that." }, { type: "response.completed", response: { id: "r", usage: { input_tokens: 1, output_tokens: 1 } } }]) });
    expect((await drain(refused, params())).final).toMatchObject({ stop_reason: "refusal", content: [] });
  });

  it("failures are classified like the Claude ones: quota is billing, a busy model falls back, a bad key alarms", async () => {
    const failing = (status: number, code: string): typeof fetch => (async () => new Response(JSON.stringify({ error: { code, message: "secret detail" } }), { status, headers: { "content-type": "application/json" } })) as never;
    const run = async (status: number, code: string) => {
      const provider = new OpenAiProvider({ apiKey: "k", transport: httpTransport("k", 5_000, "https://example.test/v1", failing(status, code)) });
      try {
        await drain(provider, params());
      } catch (e) {
        return e;
      }
      throw new Error("expected a failure");
    };
    const quota = await run(429, "insufficient_quota");
    expect(classifyError(quota)).toMatchObject({ kind: "billing", fallback: false });
    expect((quota as Error).message).not.toContain("secret detail");
    expect(classifyError(await run(429, "rate_limit_exceeded"))).toMatchObject({ kind: "availability", fallback: true, status: 429 });
    expect(classifyError(await run(503, ""))).toMatchObject({ kind: "availability", fallback: true });
    expect(classifyError(await run(401, "invalid_api_key"))).toMatchObject({ kind: "auth", status: 401 });
    expect(classifyError(await run(404, "model_not_found"))).toMatchObject({ kind: "config", fallback: true });
    // A failure reported inside the stream.
    const mid = new OpenAiProvider({ apiKey: "k", transport: (async function* () { yield { type: "response.failed", response: { id: "r", error: { code: "server_error", message: "x" } } } as never; }) });
    await expect(drain(mid, params())).rejects.toBeInstanceOf(APIError);
  });

  it("reads server-sent events split across chunks", async () => {
    const enc = new TextEncoder();
    const sse = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":3,"output_tokens":1}}}\n\n';
    const chunks = [sse.slice(0, 40), sse.slice(40, 90), sse.slice(90)];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "gpt-6.1-sol", store: false, stream: true });
      return new Response(new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as never;
    const provider = new OpenAiProvider({ apiKey: "k", transport: httpTransport("k", 5_000, "https://example.test/v1", fetchImpl) });
    expect((await drain(provider, params())).final).toMatchObject({ stop_reason: "end_turn", content: [{ type: "text", text: "Hi" }] });
  });
});

describe("RoutedProvider", () => {
  it("sends openai ids to OpenAI and the rest to Claude; without a key an openai id is a configuration error", () => {
    const mk = (name: string) => ({ stream: () => ({ name }) as never });
    const routed = new RoutedProvider(mk("claude"), mk("openai"));
    const opts = { signal: new AbortController().signal, conversationId: "c" };
    expect(routed.stream(params(), opts)).toEqual({ name: "openai" });
    expect(routed.stream(params({ model: "anthropic.claude-opus-5-5" }), opts)).toEqual({ name: "claude" });
    try {
      new RoutedProvider(mk("claude"), null).stream(params(), opts);
      throw new Error("expected a failure");
    } catch (e) {
      expect(classifyError(e)).toMatchObject({ kind: "config" });
    }
  });
});
