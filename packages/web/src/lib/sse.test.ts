import { describe, expect, it } from "vitest";
import { SseParser, readSseStream } from "./sse";

describe("SseParser", () => {
  it("parsea un evento completo", () => {
    const p = new SseParser();
    const evs = p.feed('event: text_delta\ndata: {"text":"hola"}\n\n');
    expect(evs).toEqual([{ event: "text_delta", data: '{"text":"hola"}' }]);
  });

  it("une eventos partidos entre chunks", () => {
    const p = new SseParser();
    expect(p.feed("event: text_de")).toEqual([]);
    expect(p.feed('lta\ndata: {"te')).toEqual([]);
    expect(p.feed('xt":"ho')).toEqual([]);
    const evs = p.feed('la"}\n\nevent: done\ndata: {}\n');
    expect(evs).toEqual([{ event: "text_delta", data: '{"text":"hola"}' }]);
    expect(p.feed("\n")).toEqual([{ event: "done", data: "{}" }]);
  });

  it("ignora comentarios (ping) y no rompe el búfer", () => {
    const p = new SseParser();
    expect(p.feed(": ping\n\n")).toEqual([]);
    expect(p.feed(': ping\nevent: text_delta\ndata: {"text":"a"}\n\n: otro\n')).toEqual([
      { event: "text_delta", data: '{"text":"a"}' },
    ]);
  });

  it("devuelve varios eventos de un mismo chunk, en orden", () => {
    const p = new SseParser();
    const evs = p.feed(
      'event: message_start\ndata: {"model":"m"}\n\nevent: text_delta\ndata: {"text":"1"}\n\nevent: text_delta\ndata: {"text":"2"}\n\n',
    );
    expect(evs.map((e) => e.event)).toEqual(["message_start", "text_delta", "text_delta"]);
    expect(evs[2]?.data).toBe('{"text":"2"}');
  });

  it("soporta CRLF y data multilínea", () => {
    const p = new SseParser();
    const evs = p.feed("event: x\r\ndata: a\r\ndata: b\r\n\r\n");
    expect(evs).toEqual([{ event: "x", data: "a\nb" }]);
  });

  it("no corta un CR final que podría ser CRLF", () => {
    const p = new SseParser();
    expect(p.feed("event: x\r")).toEqual([]);
    expect(p.feed("\ndata: y\r\n\r\n")).toEqual([{ event: "x", data: "y" }]);
  });

  it("usa 'message' cuando no hay campo event y respeta id", () => {
    const p = new SseParser();
    expect(p.feed("id: 7\ndata: z\n\n")).toEqual([{ event: "message", data: "z", id: "7" }]);
  });

  it("end() vacía un evento pendiente sin línea en blanco final", () => {
    const p = new SseParser();
    expect(p.feed("event: done\ndata: {}")).toEqual([]);
    expect(p.end()).toEqual([{ event: "done", data: "{}" }]);
  });
});

describe("readSseStream", () => {
  it("lee un ReadableStream troceado byte a byte (incluido UTF-8 multibyte)", async () => {
    const text = 'event: text_delta\ndata: {"text":"canción"}\n\nevent: done\ndata: {}\n\n';
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
      { event: "text_delta", data: '{"text":"canción"}' },
      { event: "done", data: "{}" },
    ]);
  });
});
