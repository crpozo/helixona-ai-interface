import { describe, expect, it } from "vitest";
import { SseParser, readSseStream } from "./sse";

describe("SseParser", () => {
  it("parses a complete event", () => {
    const p = new SseParser();
    const evs = p.feed('event: text_delta\ndata: {"text":"hola"}\n\n');
    expect(evs).toEqual([{ event: "text_delta", data: '{"text":"hola"}' }]);
  });

  it("joins events split across chunks", () => {
    const p = new SseParser();
    expect(p.feed("event: text_de")).toEqual([]);
    expect(p.feed('lta\ndata: {"te')).toEqual([]);
    expect(p.feed('xt":"ho')).toEqual([]);
    const evs = p.feed('la"}\n\nevent: done\ndata: {}\n');
    expect(evs).toEqual([{ event: "text_delta", data: '{"text":"hola"}' }]);
    expect(p.feed("\n")).toEqual([{ event: "done", data: "{}" }]);
  });

  it("ignores comments (ping) without breaking the buffer", () => {
    const p = new SseParser();
    expect(p.feed(": ping\n\n")).toEqual([]);
    expect(p.feed(': ping\nevent: text_delta\ndata: {"text":"a"}\n\n: otro\n')).toEqual([
      { event: "text_delta", data: '{"text":"a"}' },
    ]);
  });

  it("returns several events from a single chunk, in order", () => {
    const p = new SseParser();
    const evs = p.feed(
      'event: message_start\ndata: {"model":"m"}\n\nevent: text_delta\ndata: {"text":"1"}\n\nevent: text_delta\ndata: {"text":"2"}\n\n',
    );
    expect(evs.map((e) => e.event)).toEqual(["message_start", "text_delta", "text_delta"]);
    expect(evs[2]?.data).toBe('{"text":"2"}');
  });

  it("supports CRLF and multi-line data", () => {
    const p = new SseParser();
    const evs = p.feed("event: x\r\ndata: a\r\ndata: b\r\n\r\n");
    expect(evs).toEqual([{ event: "x", data: "a\nb" }]);
  });

  it("does not split a trailing CR that could be CRLF", () => {
    const p = new SseParser();
    expect(p.feed("event: x\r")).toEqual([]);
    expect(p.feed("\ndata: y\r\n\r\n")).toEqual([{ event: "x", data: "y" }]);
  });

  it("uses 'message' when there is no event field and honors id", () => {
    const p = new SseParser();
    expect(p.feed("id: 7\ndata: z\n\n")).toEqual([{ event: "message", data: "z", id: "7" }]);
  });

  it("end() flushes a pending event without a trailing blank line", () => {
    const p = new SseParser();
    expect(p.feed("event: done\ndata: {}")).toEqual([]);
    expect(p.end()).toEqual([{ event: "done", data: "{}" }]);
  });
});

describe("readSseStream", () => {
  it("reads a ReadableStream chunked byte by byte (including multibyte UTF-8)", async () => {
    const text = 'event: text_delta\ndata: {"text":"naïve ☕"}\n\nevent: done\ndata: {}\n\n';
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
        controller.close();
      },
    });
    const out = [];
    for await (const ev of readSseStream(stream)) out.push(ev);
    expect(out).toEqual([
      { event: "text_delta", data: '{"text":"naïve ☕"}' },
      { event: "done", data: "{}" },
    ]);
  });
});
