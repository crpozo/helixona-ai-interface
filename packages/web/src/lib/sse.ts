/**
 * Parser incremental de Server-Sent Events para consumir un `fetch` + `ReadableStream`.
 *
 * Soporta:
 *  - eventos partidos entre chunks (se conserva el resto en un búfer),
 *  - varios eventos en un mismo chunk,
 *  - comentarios (`: ping`), que se ignoran,
 *  - `data:` multilínea (se une con "\n", como dicta la especificación),
 *  - finales de línea `\n`, `\r\n` y `\r`.
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];
  private id: string | undefined;

  /** Alimenta texto ya decodificado y devuelve los eventos completos encontrados. */
  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];

    // Consumimos línea a línea. Si el búfer acaba en "\r" no podemos saber si
    // viene un "\n" detrás, así que esperamos al siguiente chunk.
    for (;;) {
      const nl = this.buffer.search(/\r\n|\r|\n/);
      if (nl === -1) break;
      const sepLength = this.buffer.startsWith("\r\n", nl) ? 2 : 1;
      if (sepLength === 1 && this.buffer[nl] === "\r" && nl === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + sepLength);
      const ev = this.processLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  /** Cierra el flujo: si hay un evento pendiente sin línea en blanco final, lo emite. */
  end(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.length > 0) {
      const ev = this.processLine(this.buffer);
      this.buffer = "";
      if (ev) events.push(ev);
    }
    const last = this.dispatch();
    if (last) events.push(last);
    return events;
  }

  private processLine(line: string): SseEvent | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null; // comentario / heartbeat

    let field: string;
    let value: string;
    const colon = line.indexOf(":");
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }

    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        this.id = value;
        break;
      // "retry" y campos desconocidos se ignoran.
    }
    return null;
  }

  private dispatch(): SseEvent | null {
    if (this.dataLines.length === 0 && this.eventName === "") return null;
    const ev: SseEvent = {
      event: this.eventName || "message",
      data: this.dataLines.join("\n"),
    };
    if (this.id !== undefined) ev.id = this.id;
    this.eventName = "";
    this.dataLines = [];
    return ev;
  }
}

/** Convierte un `ReadableStream<Uint8Array>` en una secuencia asíncrona de eventos SSE. */
export async function* readSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const parser = new SseParser();
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.feed(decoder.decode(value, { stream: true }))) yield ev;
    }
    for (const ev of parser.feed(decoder.decode())) yield ev;
    for (const ev of parser.end()) yield ev;
  } finally {
    reader.releaseLock();
  }
}
